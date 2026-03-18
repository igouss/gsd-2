---
estimated_steps: 7
estimated_files: 11
---

# T02: Three-column resizable layout, custom title bar, and UI primitives with placeholder content

**Slice:** S01 — Electron Shell + Design System Foundation
**Milestone:** M001-1ya5a3

## Description

Build the three-column resizable layout using `react-resizable-panels`, a custom macOS title bar, and the core UI primitives (Button, Text, Icon) that every subsequent slice imports. Each panel gets styled placeholder content that demonstrates the design system is cohesive — typography hierarchy, icon rendering, button variants, and the amber accent throughout. By the end, the app looks like a premium desktop tool, not a scaffolding demo.

**Skills to load:**
- `~/.gsd/agent/skills/frontend-design/SKILL.md` — for component design quality
- `~/.gsd/agent/skills/make-interfaces-feel-better/SKILL.md` — for polish: transitions, hover states, spacing, shadows

## Steps

1. **Verify T01 output.** Run `npm run dev -w studio` to confirm the Electron window opens with the design system working. Check that fonts load, colors render, and there are no console errors. If anything is broken from T01, fix it before proceeding.

2. **Check `react-resizable-panels` API.** The research mentions both `Group/Panel/Separator` and `PanelGroup/Panel/PanelResizeHandle` as possible export names. Before building, verify the actual exports: `import { PanelGroup, Panel, PanelResizeHandle } from 'react-resizable-panels'` — check the installed version's types. Use whatever the library actually exports. Key API features needed: `direction="horizontal"`, `defaultSize` (percentage), `minSize`, `collapsible`, `onLayout` for potential persistence.

3. **Create `TitleBar.tsx` (`studio/src/renderer/src/components/layout/TitleBar.tsx`).** A horizontal bar at the top of the app window. Must account for macOS traffic lights — `paddingLeft: 78px` (traffic light area + breathing room). The title area uses `-webkit-app-region: drag` so the window is draggable by the title bar. Display "GSD Studio" in the accent color (`--color-accent`), small text, semibold. The bar itself: `--color-bg-secondary` background, `--color-border` bottom border, ~38px height. Include a subtle right-side area for future session controls (just a placeholder div for now).

4. **Create `PanelHandle.tsx` (`studio/src/renderer/src/components/layout/PanelHandle.tsx`).** A custom drag handle for the panel resize separator. Default state: a thin (1px) vertical line in `--color-border`. Hover state: the line becomes 2px, color transitions to `--color-accent` with a short `transition-colors` (150ms). Active/dragging state: stays amber. Include a small grip indicator (3 dots vertically centered) that appears on hover. The handle should be a reasonable hit target (8-12px wide padding) even though the visual line is thin.

5. **Create `AppLayout.tsx` (`studio/src/renderer/src/components/layout/AppLayout.tsx`).** The root layout component combining `TitleBar` + `PanelGroup`. Structure:
   - `TitleBar` at top (fixed height)
   - Below: horizontal `PanelGroup` with three panels:
     - Left sidebar: `defaultSize={20}`, `minSize={15}`, `collapsible={true}`
     - Center panel: `defaultSize={50}`, `minSize={30}` (NOT collapsible — it's always visible)
     - Right panel: `defaultSize={30}`, `minSize={20}`, `collapsible={true}`
   - Two `PanelHandle` separators between panels
   - `autoSaveId="gsd-studio-layout"` on the PanelGroup for localStorage persistence of panel sizes.
   The outer container fills the full viewport height (`h-screen`), uses `flex flex-col`.

6. **Create panel placeholder components.** Three files:
   - `Sidebar.tsx`: Header "Files" with a folder Phosphor icon, a mock file tree (just styled list items with file/folder icons, indentation, hover states). Shows the design system's secondary text, hover backgrounds, icon usage.
   - `CenterPanel.tsx`: Header "Conversation", a mock message area with sample text showing the typography hierarchy — an h2 heading, body text, inline code in JetBrains Mono, a code block with dark background, and a sample "tool card" placeholder (just a bordered card with an icon, title, and muted description). Include an input bar at the bottom — a text input with amber-accented focus ring and a send button.
   - `RightPanel.tsx`: Header "Editor", a mock editor area with line numbers (in `--color-text-tertiary`) and code text in JetBrains Mono. Just hardcoded sample code — this gets replaced with Monaco in S06.
   Each placeholder should look like a real UI, not a "Coming Soon" stub. Use the design system colors, fonts, and spacing throughout.

7. **Create UI primitives.** Three reusable components:
   - `Button.tsx` (`studio/src/renderer/src/components/ui/Button.tsx`): Variants — `primary` (amber bg, dark text), `secondary` (border-only, text-secondary), `ghost` (no border, text-secondary, hover bg). Sizes — `sm`, `md`, `lg`. Use `React.forwardRef` and accept all native button props via `React.ComponentPropsWithRef<'button'>`. Implement a Radix-style `asChild` prop using `Slot` from `@radix-ui/react-slot` for polymorphism (render as link, etc). Transitions on hover/active. Disabled state with reduced opacity.
   - `Text.tsx` (`studio/src/renderer/src/components/ui/Text.tsx`): Presets — `heading` (20px, semibold, text-primary), `subheading` (14px, medium, text-primary), `body` (14px, regular, text-secondary), `label` (12px, medium, text-tertiary), `code` (13px, JetBrains Mono, text-primary). Renders as `<p>` by default, accepts `as` prop for semantic element override. Uses the type scale from the design system.
   - `Icon.tsx` (`studio/src/renderer/src/components/ui/Icon.tsx`): Wraps `@phosphor-icons/react`'s `IconContext.Provider` at the app level (or exports a configured provider). Default context: `size={18}`, `weight="regular"`, `color="currentColor"`. The component itself is just a convenience re-export pattern — individual icons are imported directly from `@phosphor-icons/react` by consumers, but the context sets defaults.

8. **Wire everything into `App.tsx`.** Replace the T01 test content with: `<IconContext.Provider>` wrapping `<AppLayout>` which contains `<TitleBar>` + panels with `<Sidebar>`, `<CenterPanel>`, `<RightPanel>`. Import the layout and all primitives.

9. **Final polish pass.** Check spacing, alignment, color consistency. Ensure no Tailwind class conflicts. Verify the amber accent is used sparingly — only for interactive elements (handles, focus rings, primary buttons, app title). The rest should be monochrome grays. Add `@radix-ui/react-slot` to studio dependencies if not already present.

## Must-Haves

- [ ] Three-column layout with resizable panels via react-resizable-panels
- [ ] Panel sizes persist to localStorage via `autoSaveId`
- [ ] Custom drag handles transition to amber on hover (150ms transition)
- [ ] Title bar with macOS traffic light offset and draggable region
- [ ] Sidebar panel is collapsible; center panel is not
- [ ] Button component with primary/secondary/ghost variants and asChild support
- [ ] Text component with heading/subheading/body/label/code presets
- [ ] Icon context provider with default size/weight for Phosphor icons
- [ ] Placeholder content in all three panels demonstrates the design system
- [ ] No Lucide icons, no purple accents, no generic component-kit aesthetics
- [ ] `npm run build -w studio` still exits 0 after all changes

## Verification

- `npm run build -w studio` exits 0
- `npm run dev -w studio` opens app with three visible columns
- Drag handles resize panels; amber highlight appears on hover
- Title bar shows "GSD Studio" in amber with traffic lights to the left
- Sidebar shows mock file tree with Phosphor icons
- Center panel shows typography hierarchy (heading, body, code) and input bar with amber focus
- Right panel shows mock editor with line numbers in JetBrains Mono
- Resizing the window does not break layout — panels flex proportionally
- Collapsing the sidebar (double-click handle or drag to minimum) hides it; center expands

## Inputs

- T01 output: working Electron app with design system CSS, fonts, tokens.ts
- `studio/src/renderer/src/App.tsx` — replace test content with layout
- `studio/src/renderer/src/styles/index.css` — may need minor additions for scrollbar styles, selection colors
- `react-resizable-panels` — already in T01 dependencies
- `@radix-ui/react-slot` — may need to be added to dependencies
- `@phosphor-icons/react` — already in T01 dependencies

## Expected Output

- `studio/src/renderer/src/components/layout/AppLayout.tsx` — three-column resizable layout
- `studio/src/renderer/src/components/layout/TitleBar.tsx` — macOS-aware title bar
- `studio/src/renderer/src/components/layout/PanelHandle.tsx` — amber-accented drag handle
- `studio/src/renderer/src/components/layout/Sidebar.tsx` — file tree placeholder
- `studio/src/renderer/src/components/layout/CenterPanel.tsx` — conversation placeholder
- `studio/src/renderer/src/components/layout/RightPanel.tsx` — editor placeholder
- `studio/src/renderer/src/components/ui/Button.tsx` — variant button primitive
- `studio/src/renderer/src/components/ui/Text.tsx` — typography primitive
- `studio/src/renderer/src/components/ui/Icon.tsx` — Phosphor icon context provider
- `studio/src/renderer/src/App.tsx` — updated with full layout composition
