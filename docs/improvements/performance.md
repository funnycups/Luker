# Performance Optimization

Luker has made multiple performance optimizations on top of SillyTavern, significantly improving startup speed, page loading experience, and daily usage fluidity. These optimizations are transparent to users — you don't need to configure anything, Luker automatically applies all optimizations.

## Parallelized Resource Loading

Luker converts multiple resource loading tasks during the startup phase to parallel execution. Localization files, UI resources, and configuration data that originally needed to be loaded sequentially can now proceed simultaneously, dramatically reducing the wait time from opening the page to being ready to use.

## Preloading Recent Chat Snapshots

When you open Luker, the system prioritizes loading snapshot information for your most recently used chats. This means your most frequently used chats can appear in the list faster, without waiting for all chat data to finish loading.

At the same time, Luker indexes metadata for recent chats (such as last message time, message count, etc.), making chat list sorting and display faster.

## Lazy-Loading Chat Index

Complementing the preloading of recent chats, Luker uses a lazy-loading strategy to build the complete chat index. The system doesn't scan all chat files at startup; instead, it builds the index only when first needed, then maintains index accuracy through incremental updates.

This is especially noticeable for users with large numbers of chat records — even if you have hundreds of chats, startup speed won't be affected.

## Deferred Initialization of Non-Critical Modules

Luker defers some non-critical feature modules to initialize only when actually needed. For example:

- Welcome page content is rendered early, so you can see the interface while waiting for other modules to load
- Lightweight UI state (such as panel collapse state, sidebar position, etc.) is restored first
- The preset manager completes initialization before chat restoration, ensuring presets are ready when chats load

This strategy makes Luker feel "ready to use sooner" — even while some modules are still loading in the background, you can already start browsing and interacting.

## Batch Token Counting

Luker optimizes token counting by combining multiple text token counting requests into batch operations, reducing the overhead of redundant calculations. When editing prompts or adjusting presets, this optimization makes the interface more responsive.

## Other Optimizations

### Android Startup Optimization

For Android devices, Luker reduces the Character Card snapshot loading pressure during startup, avoiding slow startup caused by memory and performance limitations on mobile devices.

### Data Layer Cache Improvements

Luker improves the data layer's caching strategy, promptly invalidating expired cache data after write operations, ensuring you always see the latest content while avoiding unnecessary redundant reads.

### Incremental Data Sync

Through the [Incremental Sync](/improvements/incremental-sync) mechanism, Luker only sends the changed portions when saving chat data, rather than transmitting the complete chat history every time. This not only reduces network transfer volume but also lowers the server's disk write pressure.

::: tip
These optimizations take effect automatically during daily use. If you migrate from SillyTavern to Luker, you should noticeably feel the improvement in startup and operation speed, especially with larger amounts of data.
:::

## Related Pages

- [Incremental Sync](/improvements/incremental-sync) — Incremental saving mechanism for chat data
- [Backend Storage](/improvements/backend-storage) — Backend storage architecture improvements
- [WebSocket Proxy](/improvements/ws-proxy) — Network transmission optimization
