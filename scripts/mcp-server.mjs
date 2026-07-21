#!/usr/bin/env node
import { readFile, writeFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..");
const textDecoder = new TextDecoder("utf-8", { fatal: false });

const tools = [
    {
        name: "get_app_metadata",
        description:
            "Read Betaflight Configurator package metadata such as name, version, product name, scripts, and repository.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "read_project_file",
        description: "Read a UTF-8 project file from the repository. Paths are relative to the repository root.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "Repository-relative file path." } },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "write_project_file",
        description:
            "Create or replace a UTF-8 project file. Refuses dist, node_modules, lock files, generated platform output, and paths outside the repository.",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string", description: "Repository-relative file path." },
                content: { type: "string", description: "Complete file content to write." },
            },
            required: ["path", "content"],
            additionalProperties: false,
        },
    },
    {
        name: "delete_project_file",
        description: "Delete a project file. Refuses protected/generated paths and paths outside the repository.",
        inputSchema: {
            type: "object",
            properties: { path: { type: "string", description: "Repository-relative file path." } },
            required: ["path"],
            additionalProperties: false,
        },
    },
    {
        name: "run_npm_script",
        description: "Run an allow-listed npm script for project validation or local development.",
        inputSchema: {
            type: "object",
            properties: {
                script: { type: "string", enum: ["lint", "test", "build"] },
                timeoutMs: { type: "number", minimum: 1000, maximum: 120000, default: 60000 },
            },
            required: ["script"],
            additionalProperties: false,
        },
    },
];

function contentFor(value) {
    return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }];
}

function resolveProjectPath(relativePath) {
    if (typeof relativePath !== "string" || relativePath.trim() === "") {
        throw new Error("A non-empty repository-relative path is required.");
    }

    const resolvedPath = path.resolve(repoRoot, relativePath);
    if (resolvedPath !== repoRoot && !resolvedPath.startsWith(`${repoRoot}${path.sep}`)) {
        throw new Error("Path must stay inside the repository.");
    }

    return resolvedPath;
}

function assertWritableProjectPath(relativePath) {
    const normalized = relativePath.split(/[\\/]+/).filter(Boolean);
    const protectedRoots = new Set(["android", "dist", "node_modules", "src-tauri", ".git"]);
    const protectedFiles = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);

    if (protectedRoots.has(normalized[0]) || protectedFiles.has(normalized.join("/"))) {
        throw new Error(`Refusing to modify protected or generated path: ${relativePath}`);
    }
}

async function runCommand(command, args, timeoutMs) {
    return await new Promise((resolve) => {
        const child = spawn(command, args, { cwd: repoRoot, shell: false });
        const chunks = [];
        const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

        child.stdout.on("data", (chunk) => chunks.push(chunk));
        child.stderr.on("data", (chunk) => chunks.push(chunk));
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, output: textDecoder.decode(Buffer.concat(chunks)).slice(-20000) });
        });
    });
}

async function callTool(name, args = {}) {
    switch (name) {
        case "get_app_metadata": {
            const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf-8"));
            return contentFor({
                name: packageJson.name,
                productName: packageJson.productName,
                displayName: packageJson.displayName,
                description: packageJson.description,
                version: packageJson.version,
                repository: packageJson.repository,
                scripts: packageJson.scripts,
            });
        }
        case "read_project_file": {
            const resolvedPath = resolveProjectPath(args.path);
            const fileStat = await stat(resolvedPath);
            if (!fileStat.isFile()) throw new Error("Path is not a file.");
            return contentFor(await readFile(resolvedPath, "utf-8"));
        }
        case "write_project_file": {
            assertWritableProjectPath(args.path);
            const resolvedPath = resolveProjectPath(args.path);
            await writeFile(resolvedPath, args.content, "utf-8");
            return contentFor({ path: args.path, written: true });
        }
        case "delete_project_file": {
            assertWritableProjectPath(args.path);
            const resolvedPath = resolveProjectPath(args.path);
            await rm(resolvedPath, { force: false });
            return contentFor({ path: args.path, deleted: true });
        }
        case "run_npm_script": {
            const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 60000;
            const result = await runCommand("npm", ["run", args.script], timeoutMs);
            return contentFor(result);
        }
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

async function handleRequest(request) {
    switch (request.method) {
        case "initialize":
            return {
                protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "betaflight-configurator-mcp", version: "1.0.0" },
            };
        case "tools/list":
            return { tools };
        case "tools/call":
            return await callTool(request.params?.name, request.params?.arguments ?? {});
        case "ping":
            return {};
        default:
            throw new Error(`Unsupported method: ${request.method}`);
    }
}

function send(message) {
    const payload = JSON.stringify(message);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n${payload}`);
}

async function dispatch(rawMessage) {
    let request;
    try {
        request = JSON.parse(rawMessage);
        if (!request.method) return;
        const result = await handleRequest(request);
        if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result });
    } catch (error) {
        if (request?.id !== undefined) {
            send({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error.message } });
        } else {
            send({ jsonrpc: "2.0", error: { code: -32000, message: error.message } });
        }
    }
}

let inputBuffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, chunk]);

    while (inputBuffer.length > 0) {
        const headerEnd = inputBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headers = inputBuffer.subarray(0, headerEnd).toString("utf-8");
        const contentLengthMatch = headers.match(/content-length:\s*(\d+)/i);
        if (!contentLengthMatch) {
            inputBuffer = Buffer.alloc(0);
            send({ jsonrpc: "2.0", error: { code: -32700, message: "Missing Content-Length header." } });
            return;
        }

        const contentLength = Number(contentLengthMatch[1]);
        const messageStart = headerEnd + 4;
        const messageEnd = messageStart + contentLength;
        if (inputBuffer.length < messageEnd) return;

        const rawMessage = inputBuffer.subarray(messageStart, messageEnd).toString("utf-8");
        inputBuffer = inputBuffer.subarray(messageEnd);
        void dispatch(rawMessage);
    }
});
