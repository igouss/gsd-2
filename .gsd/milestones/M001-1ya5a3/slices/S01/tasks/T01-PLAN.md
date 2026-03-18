---
estimated_steps: 8
estimated_files: 15
---

# T01: Scaffold Electron project with electron-vite, React, Tailwind v4, and design system tokens

**Slice:** S01 — Electron Shell + Design System Foundation
**Milestone:** M001-1ya5a3

## Description

Bootstrap the `studio/` Electron app from scratch using electron-vite v5, React 19, TypeScript, and Tailwind v4. This task establishes the entire build pipeline and design system — colors, typography, spacing — as CSS custom properties in a Tailwind v4 `@theme` block. Fonts (Inter + JetBrains Mono) are bundled locally. The preload script exposes typed IPC channel stubs via `contextBridge` for S02 to wire up. By the end, `npm run dev -w studio` opens a dark-themed Electron window with correct fonts and styled content.

**Skill to load:** `~/.gsd/agent/skills/frontend-design/SKILL.md` — for design system quality and avoiding generic aesthetics.

## Steps

1. **Add `"studio"` to root workspace config.** Edit the root `package.json` — change `"workspaces": ["packages/*"]` to `"workspaces": ["packages/*", "studio"]`.

2. **Create `studio/package.json`.** Name: `@gsd/studio`, private: true. Dependencies: `react` (^19), `react-dom` (^19), `@phosphor-icons/react` (^2.1), `react-resizable-panels` (^2.1), `zustand` (^5). DevDependencies: `electron` (^35), `electron-vite` (^3), `@vitejs/plugin-react` (^4), `@tailwindcss/vite` (^4), `tailwindcss` (^4), `typescript` (^5.4), `@types/react` (^19), `@types/react-dom` (^19), `@types/node` (^22). Scripts: `dev: "electron-vite dev"`, `build: "electron-vite build"`, `preview: "electron-vite preview"`. **Important:** Check the actual latest versions of `electron-vite` on npm — it may be v2 or v3, not v5 as research suggested. The research version numbers need verification at install time. Same for `react-resizable-panels` — the research says v4.7 but the actual latest may differ. Use `^` ranges and let npm resolve.

3. **Create TypeScript configs.** Three files following electron-vite convention:
   - `studio/tsconfig.json` — references `tsconfig.node.json` and `tsconfig.web.json`
   - `studio/tsconfig.node.json` — for main + preload (Node target, ESM)
   - `studio/tsconfig.web.json` — for renderer (DOM lib, JSX react-jsx, path aliases)

4. **Create `studio/electron.vite.config.ts`.** Three build sections:
   - `main`: entry `src/main/index.ts`
   - `preload`: entry `src/preload/index.ts`
   - `renderer`: entry `src/renderer/index.html`, plugins: `@tailwindcss/vite`, `@vitejs/plugin-react`. **Critical:** The Tailwind plugin must be in the renderer section only, not top-level.

5. **Create Electron main process (`studio/src/main/index.ts`).** `app.whenReady()` → create `BrowserWindow` with: `width: 1400, height: 900`, `titleBarStyle: 'hiddenInset'` (macOS), `trafficLightPosition: { x: 16, y: 16 }`, `backgroundColor: '#0a0a0a'`, `webPreferences: { preload, contextIsolation: true, nodeIntegration: false }`. Load the renderer URL (electron-vite provides the env variable for dev vs production). Log `"GSD Studio ready"` to stdout on window creation. Handle `window-all-closed` to quit on non-macOS, `activate` to recreate window on macOS.

6. **Create preload script (`studio/src/preload/index.ts`) and type declaration (`studio/src/preload/index.d.ts`).** Use `contextBridge.exposeInMainWorld('studio', { ... })` with stubs: `onEvent(callback)` → no-op, `sendCommand(command, args)` → no-op, `spawn()` → no-op, `getStatus()` → `Promise.resolve({ connected: false })`. The type declaration file (`index.d.ts`) should declare the `window.studio` interface so the renderer can use it with type safety. These stubs get real implementations in S02.

7. **Create renderer entry files.** `studio/src/renderer/index.html` — minimal HTML with `<div id="root">`, charset meta, viewport meta, and `<link rel="preload">` for font woff2 files. `studio/src/renderer/src/main.tsx` — `createRoot(document.getElementById('root')).render(<App />)`, imports `./styles/index.css`.

8. **Build the design system CSS (`studio/src/renderer/src/styles/index.css`).** Structure:
   - `@import "tailwindcss";`
   - `@font-face` declarations for Inter (regular 400, medium 500, semibold 600) and JetBrains Mono (regular 400, medium 500) — relative paths to `../assets/fonts/`, `font-display: block`.
   - `@theme { }` block defining all CSS custom properties:
     - Colors: `--color-bg-primary: #0a0a0a`, `--color-bg-secondary: #111111`, `--color-bg-tertiary: #1a1a1a`, `--color-bg-hover: #222222`, `--color-border: #262626`, `--color-border-active: #333333`, `--color-text-primary: #e5e5e5`, `--color-text-secondary: #a3a3a3`, `--color-text-tertiary: #737373`, `--color-accent: #d4a04e`, `--color-accent-hover: #e0b366`, `--color-accent-muted: rgba(212, 160, 78, 0.15)`
     - Fonts: `--font-sans: 'Inter', system-ui, sans-serif`, `--font-mono: 'JetBrains Mono', ui-monospace, monospace`
   - Base styles on `body`: `bg-primary` background, `text-primary` color, `font-sans`, antialiased rendering (`-webkit-font-smoothing: antialiased`).
   - Scrollbar styles: thin, dark track, subtle thumb.

9. **Bundle font files.** Download Inter (woff2: regular, medium, semibold) and JetBrains Mono (woff2: regular, medium) into `studio/src/renderer/src/assets/fonts/`. Use specific weights, not variable fonts, for consistent rendering. Source from Google Fonts CDN or the project's GitHub releases — download at scaffold time, commit the files.

10. **Create `studio/src/renderer/src/lib/theme/tokens.ts`.** TypeScript constants mirroring the CSS custom properties — `colors`, `fonts`, `fontSizes` objects. These are used programmatically by Monaco theme (S06) and Shiki theme (S03). Export as named exports.

11. **Create `studio/src/renderer/src/App.tsx`.** A simple component that renders test content proving the theme works: a heading in Inter, a code block in JetBrains Mono, the amber accent color, and some text at different hierarchy levels. This gets replaced with the full layout in T02.

12. **Run `npm install` from the repo root.** Verify the workspace resolves. Then `npm run dev -w studio` to confirm the Electron window opens. Then `npm run build -w studio` to confirm production build succeeds.

## Must-Haves

- [ ] `studio/` added to root workspaces, `npm install` succeeds
- [ ] `electron.vite.config.ts` has three build sections with Tailwind in renderer only
- [ ] `@theme` block defines all 12+ color tokens, font families, and type scale
- [ ] Inter and JetBrains Mono woff2 files bundled locally (not CDN)
- [ ] `@font-face` declarations use `font-display: block` to prevent FOUT
- [ ] Preload exposes `window.studio` with typed IPC stubs via contextBridge
- [ ] `npm run dev -w studio` opens an Electron window with styled dark-theme content
- [ ] `npm run build -w studio` exits 0
- [ ] Main process logs "GSD Studio ready" to stdout

## Verification

- `cd studio && npm run build` exits with code 0
- `npm run dev -w studio` opens a window — visually confirm dark background, Inter font, JetBrains Mono in code, amber accent visible
- No console errors in Electron DevTools
- Font files exist in `studio/src/renderer/src/assets/fonts/` (at least 5 woff2 files)

## Inputs

- Root `package.json` — need to add `"studio"` to workspaces array
- Research spec in `S01-RESEARCH.md` — color palette, typography, directory structure, electron-vite config shape (already inlined in this plan)
- Decisions D001 (Electron), D004 (Radix + Tailwind), D005 (Phosphor), D006 (Inter + JetBrains Mono), D007 (dark monochrome + amber)

## Expected Output

- `studio/package.json` — workspace package with all dependencies
- `studio/electron.vite.config.ts` — three-section build config
- `studio/tsconfig.json`, `studio/tsconfig.node.json`, `studio/tsconfig.web.json` — TypeScript configs
- `studio/src/main/index.ts` — Electron main process with BrowserWindow
- `studio/src/preload/index.ts` — contextBridge with typed IPC stubs
- `studio/src/preload/index.d.ts` — TypeScript declarations for window.studio
- `studio/src/renderer/index.html` — HTML entry with font preload links
- `studio/src/renderer/src/main.tsx` — React root render
- `studio/src/renderer/src/App.tsx` — Test component proving theme works
- `studio/src/renderer/src/styles/index.css` — Full design system CSS with @theme block
- `studio/src/renderer/src/lib/theme/tokens.ts` — TypeScript design tokens
- `studio/src/renderer/src/assets/fonts/*.woff2` — Bundled font files
