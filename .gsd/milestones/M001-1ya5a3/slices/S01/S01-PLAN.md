# S01: Electron Shell + Design System Foundation

**Goal:** Deliver a working Electron desktop app with the full design system (dark monochrome + warm amber), three-column resizable layout, custom title bar, and core UI primitives — the foundation every subsequent slice builds on.
**Demo:** `npm run dev -w studio` opens a native macOS window with three resizable columns (sidebar, center, right panel), amber-accented drag handles, Inter + JetBrains Mono typography, Phosphor icons, and styled placeholder content in each panel. Dragging handles resizes panels. The app looks premium — not a prototype.

## Must-Haves

- Electron window launches via `npm run dev -w studio` with HMR
- Tailwind v4 CSS-first `@theme` block defines the full color palette, typography scale, and spacing system
- Inter (UI) and JetBrains Mono (code) fonts bundled locally as woff2 assets
- Three-column layout via `react-resizable-panels` with draggable dividers
- Custom panel handles with amber accent on hover/drag
- macOS title bar with `titleBarStyle: 'hiddenInset'` and proper traffic light offset
- Core UI primitives: Button, Text, Icon (Phosphor wrapper)
- Preload script with `contextBridge` stubs for IPC channels (wired in S02)
- TypeScript design tokens file mirroring CSS custom properties
- `npm run build -w studio` produces a working production build
- No Lucide icons, no purple, no shadcn aesthetic, no generic fonts

## Proof Level

- This slice proves: contract (the design system and layout shell that all subsequent slices consume)
- Real runtime required: yes (Electron must launch and render)
- Human/UAT required: yes (visual quality assessment — does it feel premium?)

## Verification

- `cd studio && npm run build` succeeds with exit code 0 (production build works)
- `npm run dev -w studio` launches an Electron window (manual verification)
- Three columns visible with drag handles; resizing works
- Panel handles show amber (`#d4a04e`) on hover
- Inter font renders in UI text, JetBrains Mono in code-styled elements
- Phosphor icons render at correct size/weight
- Title bar has macOS traffic light buttons with no content overlap
- All placeholder panels show styled content with correct dark theme colors
- HMR works — editing a React component hot-reloads without restart

## Observability / Diagnostics

- Runtime signals: Electron main process logs to stdout (app ready, window created, preload loaded)
- Inspection surfaces: `npm run dev -w studio` console output, Electron DevTools in renderer
- Failure visibility: Build errors surface in terminal; renderer errors in DevTools console
- Redaction constraints: none

## Integration Closure

- Upstream surfaces consumed: none (first slice)
- New wiring introduced: `studio/` workspace added to root `package.json`, electron-vite build pipeline, contextBridge IPC stubs
- What remains before milestone is truly usable end-to-end: S02 (RPC connection), S03 (message rendering), S04 (tool cards), S05 (prompts), S06 (file tree + editor), S07 (preview + final integration)

## Tasks

- [ ] **T01: Scaffold Electron project with electron-vite, React, Tailwind v4, and design system tokens** `est:1h`
  - Why: Everything else depends on the build pipeline working. This task gets `npm run dev -w studio` opening an Electron window with styled content — proving the full toolchain (electron-vite, React 19, Tailwind v4, font loading) works end-to-end.
  - Files: `studio/package.json`, `studio/electron.vite.config.ts`, `studio/tsconfig.json`, `studio/tsconfig.node.json`, `studio/tsconfig.web.json`, `studio/src/main/index.ts`, `studio/src/preload/index.ts`, `studio/src/preload/index.d.ts`, `studio/src/renderer/index.html`, `studio/src/renderer/src/main.tsx`, `studio/src/renderer/src/App.tsx`, `studio/src/renderer/src/styles/index.css`, `studio/src/renderer/src/lib/theme/tokens.ts`, `studio/src/renderer/src/assets/fonts/` (Inter + JetBrains Mono woff2), `package.json` (root — add studio to workspaces)
  - Do: Create `studio/` directory structure following electron-vite conventions (`src/main/`, `src/preload/`, `src/renderer/`). Set up `electron.vite.config.ts` with three build sections — renderer section gets `@tailwindcss/vite` and `@vitejs/plugin-react`. Define the full design system in `index.css` `@theme` block (all colors, typography, spacing from the research spec). Bundle Inter and JetBrains Mono as local woff2 with `@font-face` declarations (`font-display: block`). Create `contextBridge` preload with typed IPC channel stubs. Create minimal `App.tsx` that renders styled test content proving the theme works. Create `tokens.ts` mirroring CSS custom properties for programmatic access. Add `"studio"` to root `package.json` workspaces. Run `npm install` from root. **Skills to load:** `frontend-design` for design system quality.
  - Verify: `npm run dev -w studio` opens an Electron window showing styled content with correct fonts and dark theme. `npm run build -w studio` exits 0.
  - Done when: Electron window opens with Inter font in UI text, JetBrains Mono in a code element, dark background (`#0a0a0a`), amber accent color visible, and production build succeeds.

- [ ] **T02: Three-column resizable layout, custom title bar, and UI primitives with placeholder content** `est:45m`
  - Why: Delivers the spatial layout, interaction design (resizable panels with amber handles), title bar, and the reusable UI primitives (Button, Text, Icon) that every subsequent slice imports. Placeholder content in each panel proves the design system is cohesive.
  - Files: `studio/src/renderer/src/App.tsx` (update), `studio/src/renderer/src/components/layout/AppLayout.tsx`, `studio/src/renderer/src/components/layout/Sidebar.tsx`, `studio/src/renderer/src/components/layout/CenterPanel.tsx`, `studio/src/renderer/src/components/layout/RightPanel.tsx`, `studio/src/renderer/src/components/layout/PanelHandle.tsx`, `studio/src/renderer/src/components/layout/TitleBar.tsx`, `studio/src/renderer/src/components/ui/Button.tsx`, `studio/src/renderer/src/components/ui/Text.tsx`, `studio/src/renderer/src/components/ui/Icon.tsx`, `studio/src/renderer/src/styles/index.css` (update if needed)
  - Do: Install `react-resizable-panels`. Build `AppLayout.tsx` with `PanelGroup`/`Panel`/`PanelResizeHandle` in a three-column layout (sidebar ~20%, center ~50%, right ~30%). Create `PanelHandle.tsx` — a thin vertical bar that shows amber accent on hover/active with a subtle grip indicator. Create `TitleBar.tsx` with `titleBarStyle: 'hiddenInset'` offset (68px padding-left for traffic lights), `-webkit-app-region: drag` for the title area, app name "GSD Studio" in amber. Build `Sidebar.tsx`, `CenterPanel.tsx`, `RightPanel.tsx` with placeholder content that demonstrates the design system — use typography hierarchy, icon samples, color palette preview. Create `Button.tsx` (primary/secondary/ghost variants using Tailwind, Radix Slot pattern for polymorphism), `Text.tsx` (heading/body/label/code presets mapping to the type scale), `Icon.tsx` (thin Phosphor wrapper with `IconContext` provider setting default size/weight/color). Wire everything into `App.tsx`. Ensure panels have min-width constraints and the center panel cannot be collapsed. **Skills to load:** `frontend-design` for component quality, `make-interfaces-feel-better` for polish details. **Note on react-resizable-panels v4+ API:** The library exports `PanelGroup`, `Panel`, `PanelResizeHandle` — the research mentions `Group`/`Panel`/`Separator` names but verify against actual imports.
  - Verify: `npm run dev -w studio` shows three-column layout. Dragging handles resizes panels. Handles show amber on hover. Title bar has traffic light offset. Button, Text, Icon components render correctly in placeholder content. `npm run build -w studio` still exits 0.
  - Done when: App shows three resizable columns with amber-accented drag handles, macOS title bar with traffic lights, placeholder content using all three UI primitives (Button, Text, Icon), Inter and JetBrains Mono visible in appropriate contexts, and the overall aesthetic reads as premium dark-theme design — not a prototype.

## Files Likely Touched

- `package.json` (root — workspaces update)
- `studio/package.json`
- `studio/electron.vite.config.ts`
- `studio/tsconfig.json`
- `studio/tsconfig.node.json`
- `studio/tsconfig.web.json`
- `studio/src/main/index.ts`
- `studio/src/preload/index.ts`
- `studio/src/preload/index.d.ts`
- `studio/src/renderer/index.html`
- `studio/src/renderer/src/main.tsx`
- `studio/src/renderer/src/App.tsx`
- `studio/src/renderer/src/styles/index.css`
- `studio/src/renderer/src/lib/theme/tokens.ts`
- `studio/src/renderer/src/assets/fonts/*.woff2`
- `studio/src/renderer/src/components/layout/AppLayout.tsx`
- `studio/src/renderer/src/components/layout/Sidebar.tsx`
- `studio/src/renderer/src/components/layout/CenterPanel.tsx`
- `studio/src/renderer/src/components/layout/RightPanel.tsx`
- `studio/src/renderer/src/components/layout/PanelHandle.tsx`
- `studio/src/renderer/src/components/layout/TitleBar.tsx`
- `studio/src/renderer/src/components/ui/Button.tsx`
- `studio/src/renderer/src/components/ui/Text.tsx`
- `studio/src/renderer/src/components/ui/Icon.tsx`
