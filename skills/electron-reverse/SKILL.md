---
name: electron-reverse
description: Open an Electron app: unpack asar, read the IPC bridge, find the privileged surface, and see what the renderer can reach.
---

# Electron reverse

Electron apps ship their source. The bug is rarely in the code you can read; it is in the bridge you can call.

## 1. Unpack
```bash
npx asar extract app.asar app
```
Look for `main.js`, `preload.js`, `package.json` (fuses and build config), and the renderer bundle.

## 2. Map the trust boundary
Three processes, three privileges:
- **main**: Node, full disk, network, child processes.
- **preload**: the bridge. This is where the app's real API is defined.
- **renderer**: the web page. Sandboxed in theory; the preload decides what it can ask for.

Read the preload first. Every `contextBridge.exposeInMainWorld` and every `ipcRenderer.invoke` is a capability. List them.

## 3. Find the dangerous channels
For each IPC handler in main, ask: does it take a path, a URL, a shell string, or a serialized object?
- `shell.openExternal(url)` with an unvalidated URL = RCE via protocol handler.
- `fs.readFile(path)` with a renderer-supplied path = arbitrary file read.
- `child_process.exec(cmd)` with any renderer input = command injection.
- `webContents.executeJavaScript` on remote content = XSS to RCE.

Trace each exposed channel back to whether renderer-controlled data reaches it. That path is the finding.

## 4. Check the fuses
`package.json` build config and `@electron/fuses`: `RunAsNode`, `EnableNodeCliInspectArguments`, `OnlyLoadAppFromAsar`. A disabled fuse turns a local app into a launch vehicle.

## 5. Content security and navigation
Look for `webSecurity: false`, a missing `will-navigate` guard, and `setWindowOpenHandler` that allows arbitrary windows. Deep links (`app://` protocol handlers) are the usual entry.

## 6. Prove it
Reproduce with a request or a URL, not a theory. Show the exact channel, the input, and the effect. Then use `finding-report`.

## Rules
- Read the shipped app, do not redistribute its code.
- Test on an app you own or are authorized to examine.
