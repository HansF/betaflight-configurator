# Betaflight Configurator MCP server

Betaflight Configurator includes a local Model Context Protocol (MCP) server for external coding agents such as Claude Desktop, Gemini CLI, or Codex CLI.

The server uses the standard MCP JSON-RPC protocol over stdio. It is intentionally local-only: it does not open a network port and it only operates on files inside the repository.

## Start the server

```sh
npm run mcp
```

## Example client configuration

Point your MCP client at the repository and run the npm script:

```json
{
    "mcpServers": {
        "betaflight-configurator": {
            "command": "npm",
            "args": ["run", "mcp"],
            "cwd": "/path/to/betaflight-configurator"
        }
    }
}
```

## Available tools

- `get_app_metadata` reads the application package metadata and npm scripts.
- `read_project_file` reads a UTF-8 file by repository-relative path.
- `write_project_file` creates or replaces a UTF-8 file by repository-relative path.
- `delete_project_file` deletes a file by repository-relative path.
- `run_npm_script` runs one of the allow-listed validation scripts: `lint`, `test`, or `build`.

## Safety boundaries

The write and delete tools reject paths outside the repository and refuse generated or dependency output such as `dist/`, `node_modules/`, native platform output, `.git/`, and lock files.
