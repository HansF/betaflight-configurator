import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function encode(payload) {
    const body = JSON.stringify(payload);
    return `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
}

function decode(buffer) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    const headers = buffer.slice(0, headerEnd);
    const contentLength = Number(headers.match(/content-length:\s*(\d+)/i)[1]);
    return JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + contentLength));
}

function request(child, payload) {
    return new Promise((resolve, reject) => {
        let buffer = "";
        const onData = (chunk) => {
            buffer += chunk.toString("utf-8");
            if (!buffer.includes("\r\n\r\n")) return;

            child.stdout.off("data", onData);
            resolve(decode(buffer));
        };
        child.stdout.on("data", onData);
        child.once("error", reject);
        child.stdin.write(encode(payload));
    });
}

describe("MCP server", () => {
    it("advertises Betaflight Configurator tools over JSON-RPC", async () => {
        const child = spawn(process.execPath, ["scripts/mcp-server.mjs"], { stdio: ["pipe", "pipe", "pipe"] });

        try {
            const initialize = await request(child, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
            expect(initialize.result.serverInfo.name).toBe("betaflight-configurator-mcp");

            const tools = await request(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
            expect(tools.result.tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining([
                    "get_app_metadata",
                    "read_project_file",
                    "write_project_file",
                    "delete_project_file",
                    "run_npm_script",
                ]),
            );
        } finally {
            child.kill();
        }
    });
});
