// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

#import "NodeBridge.h"

#include <atomic>
#include <condition_variable>
#include <exception>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "node.h"
#include "v8.h"

namespace {

// The embedded server entry point is an ES module. The CommonJS runner exposed
// by the embedder API compiles CommonJS source, so it loads a shim that hands
// the entry point to the ES module loader.
constexpr const char *kBootstrapShim =
    "const { pathToFileURL } = require('node:url');\n"
    "import(pathToFileURL(process.argv[1]).href).catch((error) => {\n"
    "  console.error(error);\n"
    "  process.exit(1);\n"
    "});\n";

// Serializes start and stop so the thread handle is never joined twice. The
// Node thread never takes this mutex.
std::mutex g_lifecycle_mutex;
// Protects the environment pointer and the startup flag shared with the Node
// thread.
std::mutex g_mutex;
std::condition_variable g_state_changed;
std::thread g_node_thread;                   // guarded by g_lifecycle_mutex
node::Environment *g_environment = nullptr;  // guarded by g_mutex
bool g_starting = false;                     // guarded by g_mutex
std::atomic<bool> g_running(false);

std::once_flag g_process_init_once;
bool g_process_init_ok = false;
std::string g_process_init_error;
std::unique_ptr<node::MultiIsolatePlatform> g_platform;
// Node.js options parsed out of the first start, reused as process.execArgv.
std::vector<std::string> g_node_options;

bool ensure_process_initialized(const std::vector<std::string> &argv) {
    std::call_once(g_process_init_once, [&argv]() {
        std::shared_ptr<node::InitializationResult> result =
            node::InitializeOncePerProcess(
                argv,
                {node::ProcessInitializationFlags::kNoInitializeV8,
                 node::ProcessInitializationFlags::kNoInitializeNodeV8Platform});
        for (const std::string &error : result->errors()) {
            NSLog(@"[LukerNative] Node initialization: %s", error.c_str());
        }
        if (result->early_return()) {
            g_process_init_error = "node::InitializeOncePerProcess failed";
            return;
        }
        g_platform = node::MultiIsolatePlatform::Create(4);
        if (!g_platform) {
            g_process_init_error = "node::MultiIsolatePlatform::Create returned null";
            return;
        }
        v8::V8::InitializePlatform(g_platform.get());
        if (!v8::V8::Initialize()) {
            g_process_init_error = "v8::V8::Initialize failed";
            return;
        }
        g_node_options = result->exec_args();
        g_process_init_ok = true;
    });
    return g_process_init_ok;
}

// Rebuilds the non-Node.js argument list from the new argv. The Node.js option
// prefix is fixed for the process, so only the script and its arguments can
// change between starts.
bool build_environment_args(const std::vector<std::string> &argv,
                            std::vector<std::string> *args,
                            std::string *error) {
    if (argv.size() < g_node_options.size() + 2) {
        *error = "argument list is shorter than the Node option prefix";
        return false;
    }
    for (size_t i = 0; i < g_node_options.size(); i++) {
        if (argv[i + 1] != g_node_options[i]) {
            *error = "Node options changed between runtime starts";
            return false;
        }
    }
    args->clear();
    args->push_back(argv[0]);
    args->insert(args->end(), argv.begin() + 1 + g_node_options.size(), argv.end());
    return true;
}

void finish_startup_failure() {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_starting = false;
    g_running.store(false);
    g_state_changed.notify_all();
}

v8::MaybeLocal<v8::Value> run_bootstrap(const node::StartExecutionCallbackInfo &info) {
    v8::Isolate *isolate = info.process_object->GetIsolate();
    v8::Local<v8::Context> context = isolate->GetCurrentContext();
    v8::Local<v8::String> source;
    if (!v8::String::NewFromUtf8(isolate, kBootstrapShim, v8::NewStringType::kNormal)
             .ToLocal(&source)) {
        return v8::MaybeLocal<v8::Value>();
    }
    v8::Local<v8::Value> call_args[] = {source};
    return info.run_cjs->Call(context, info.process_object, 1, call_args);
}

void node_thread_main(std::vector<std::string> argv) {
    if (!ensure_process_initialized(argv)) {
        NSLog(@"[LukerNative] Node process initialization failed: %s", g_process_init_error.c_str());
        finish_startup_failure();
        return;
    }

    std::vector<std::string> args;
    std::string error;
    if (!build_environment_args(argv, &args, &error)) {
        NSLog(@"[LukerNative] %s", error.c_str());
        finish_startup_failure();
        return;
    }

    std::vector<std::string> errors;
    std::unique_ptr<node::CommonEnvironmentSetup> setup =
        node::CommonEnvironmentSetup::Create(g_platform.get(), &errors, args, g_node_options);
    if (!setup) {
        std::string joined;
        for (const std::string &item : errors) {
            joined += item + "\n";
        }
        NSLog(@"[LukerNative] Failed to create the Node environment: %s", joined.c_str());
        finish_startup_failure();
        return;
    }

    v8::Isolate *isolate = setup->isolate();
    node::Environment *environment = setup->env();
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_environment = environment;
        g_starting = false;
        g_state_changed.notify_all();
    }

    // process.exit() must stop this environment instead of terminating the
    // process, otherwise the platform and V8 would be torn down for good.
    node::SetProcessExitHandler(environment, [](node::Environment *env, int exit_code) {
        NSLog(@"[LukerNative] Node process.exit requested with code=%d", exit_code);
        node::Stop(env);
    });

    {
        v8::Locker locker(isolate);
        v8::Isolate::Scope isolate_scope(isolate);
        v8::HandleScope handle_scope(isolate);
        v8::Local<v8::Context> context = setup->context();
        v8::Context::Scope context_scope(context);

        v8::MaybeLocal<v8::Value> loaded = node::LoadEnvironment(environment, run_bootstrap);
        if (loaded.IsEmpty()) {
            NSLog(@"[LukerNative] Failed to load the Node bootstrap");
        } else {
            v8::Maybe<int> loop_result = node::SpinEventLoop(environment);
            if (loop_result.IsNothing()) {
                NSLog(@"[LukerNative] Node event loop stopped");
            } else {
                NSLog(@"[LukerNative] Node event loop exited with code=%d", loop_result.FromJust());
            }
        }

        // node::Stop() terminates execution from another thread; clear the
        // termination state before the environment and isolate are freed.
        isolate->CancelTerminateExecution();
    }

    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_environment = nullptr;
    }
    setup.reset();

    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_starting = false;
        g_running.store(false);
        g_state_changed.notify_all();
    }
    NSLog(@"[LukerNative] Node runtime thread exited");
}

}  // namespace

extern "C" int luker_node_start(const char *const *argv, int argc) {
    if (argv == nullptr || argc <= 0) {
        return -1;
    }
    std::vector<std::string> args(argc);
    for (int i = 0; i < argc; i++) {
        if (argv[i] == nullptr) {
            return -1;
        }
        args[i] = argv[i];
    }

    std::lock_guard<std::mutex> lifecycle(g_lifecycle_mutex);
    if (g_node_thread.joinable()) {
        if (g_running.load()) {
            return 0;
        }
        // The previous thread exited on its own; reap it before restarting.
        g_node_thread.join();
    }
    {
        std::lock_guard<std::mutex> lock(g_mutex);
        g_starting = true;
    }
    g_running.store(true);
    try {
        g_node_thread = std::thread(node_thread_main, std::move(args));
    } catch (const std::exception &e) {
        NSLog(@"[LukerNative] Failed to create the Node thread: %s", e.what());
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_starting = false;
        }
        g_running.store(false);
        return -1;
    } catch (...) {
        NSLog(@"[LukerNative] Failed to create the Node thread: unknown error");
        {
            std::lock_guard<std::mutex> lock(g_mutex);
            g_starting = false;
        }
        g_running.store(false);
        return -1;
    }

    return 0;
}

extern "C" int luker_node_stop(void) {
    std::lock_guard<std::mutex> lifecycle(g_lifecycle_mutex);
    if (!g_node_thread.joinable()) {
        return 0;
    }
    {
        std::unique_lock<std::mutex> lock(g_mutex);
        // Wait for the environment to exist or for startup to fail; joining a
        // thread that is still creating the environment would leave it running.
        g_state_changed.wait(lock, [] { return g_environment != nullptr || !g_starting; });
        if (g_environment != nullptr) {
            node::Stop(g_environment);
        }
    }
    // The Node thread clears the environment and the running flag before it
    // exits, so joining is the only cleanup needed here.
    g_node_thread.join();
    return 0;
}

extern "C" bool luker_node_is_running(void) {
    return g_running.load();
}
