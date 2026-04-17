# Plugin Regex Provider

Plugin Regex Provider is an extension mechanism introduced by Luker that allows plugins to dynamically register regex rules into SillyTavern's regex processing system.

## Overview

SillyTavern's regex system allows users to define text replacement rules that process text before AI responses are displayed (e.g., formatting, filtering specific content, etc.). Luker extends this system by allowing plugins to act as regex rule "providers," dynamically registering and managing regex rules.

## How It Works

Plugins can register as regex Providers, supplying dynamic matching rules to the regex system. These rules participate in text processing alongside user-created regex rules.

Unlike user-created static rules, plugin-registered rules are dynamic — plugins can adjust rule content and behavior in real-time based on the current conversation state, character settings, and other conditions.

## Use Cases

- **Memory Graph**: The Memory Graph plugin uses this mechanism to inject graph node content into the regex processing pipeline
- **Custom formatting**: Plugins can dynamically adjust text formatting rules based on character settings
- **Content filtering**: Plugins can dynamically add or remove filtering rules based on the scenario

## Developer Reference

If you are a plugin developer and want to register regex rules in your own plugin, please refer to [Extension API Reference — Regex Runtime API](/development/extension-api#regex-runtime-api) for complete API documentation and code examples.

## Related Pages

- [Memory Graph](/features/memory-graph) — The primary user of Plugin Regex Provider
- [Extension API Reference](/development/extension-api) — Complete extension API documentation
- [Plugin Development Basics](/development/plugin-basics) — How to develop Luker plugins
