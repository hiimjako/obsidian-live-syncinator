# Obsidian Syncinator

The Obsidian-Syncinator is a plugin for Obsidian that keeps your workspace in synchronization across multiple devices, live and in real-time that aims to eventually consistency.
It depends and requires [syncinator-server](https://github.com/hiimjako/obsidian-live-syncinator-server) to be deployed. Follow the documentation to set it up.

# Why the Name?

Drawing inspiration from the inventive naming style of Heinz Doofenshmirtz (Phineas and Ferb).

# Installation

1. Build the plugin:
   ```sh
   npm install
   npm run build
   ```
2. Copy the plugin into your vault:
   ```sh
   mkdir -p /path/to/your/vault/.obsidian/plugins/obsidian-syncinator
   cp main.js manifest.json /path/to/your/vault/.obsidian/plugins/obsidian-syncinator/
   ```
3. Open (or restart) Obsidian
4. Go to **Settings > Community plugins**, enable **Syncinator**
5. Configure the server address and workspace credentials in the plugin settings

# Development

1. Clone the repository
2. Install dependencies:
   ```sh
   npm install
   ```
3. Build in watch mode:
   ```sh
   npm run dev
   ```
4. Copy the built files into your vault's plugin folder (as above) after each change, or point `dev` output there directly
5. Run tests:
   ```sh
   npm test
   ```

# Disclaimer

This is recreational software provided as-is, without any warranty. While the plugin is functional, I do not assume any responsibility for potential data loss or other issues that may arise from its use. Always maintain backups of your important data before using any synchronization tools.

# TODO

- Add sync for configurations
    - Add also a settings page to decide what to sync
- Add cursor of other clients
- Lazy load files in memory
- Fix file/folder rename on init
- Add file snapshots
