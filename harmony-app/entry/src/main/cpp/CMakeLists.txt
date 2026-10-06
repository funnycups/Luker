cmake_minimum_required(VERSION 3.5.0)
project(luker_runtime)

add_compile_definitions(_GNU_SOURCE)

add_library(node_ctl SHARED node_ctl.c)
target_compile_options(node_ctl PRIVATE -fno-omit-frame-pointer)
target_link_libraries(node_ctl PUBLIC libace_napi.z.so libhilog_ndk.z.so)
