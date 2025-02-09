# Obsidian Syncinator

The Obsidian-Syncinator is a plugin for Obsidian that keeps your workspace in synchronization across multiple devices, live and in real-time that aims to eventually consistency.
It depends and requires [syncinator-server](https://github.com/hiimjako/obsidian-live-syncinator-server) to be deployed. Follow the documentation to set it up.

# Why the Name?

Drawing inspiration from the inventive naming style of Heinz Doofenshmirtz (Phineas and Ferb).

# Development

To test this plugin:

1. Clone the repository
1. Link the repository inside the `.obisdian/plugins` of your obsidian workspace
1. Open/Reopen obsidian
1. Enable plugin in the settings
1. Configure plugin

# Disclaimer

This is recreational software provided as-is, without any warranty. While the plugin is functional, I do not assume any responsibility for potential data loss or other issues that may arise from its use. Always maintain backups of your important data before using any synchronization tools.

# TODO

- Add sync for configurations
    - Add also a settings page to decide what to sync
- Add cursor of other clients
- Add heartbeat on ws connection
- Lazy load files in memory
- Fix file/folder rename on init
