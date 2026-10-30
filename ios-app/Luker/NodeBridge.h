// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 FunnyCups (https://github.com/funnycups)

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/// Starts the embedded Node.js runtime on a background thread.
///
/// The first call initializes the Node platform and V8 for the process; later
/// calls reuse them, so start and stop can repeat. The returned value is 0 on
/// success and -1 when the runtime could not be started.
int luker_node_start(const char *const *argv, int argc);

/// Stops the embedded Node.js runtime and waits for its thread to exit.
/// Returns 0 when the runtime is stopped or was not running.
int luker_node_stop(void);

/// Whether the Node event loop thread is still running.
bool luker_node_is_running(void);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
