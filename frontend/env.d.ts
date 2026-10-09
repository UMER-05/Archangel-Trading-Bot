/// <reference types="next/env" />

// TS 5.9's stricter isolatedModules checking (TS2882) flags plain
// side-effect imports like `import "./globals.css"` unless something
// declares that pattern as a real module — Next.js's own webpack loader
// already handles the actual CSS import at build/runtime regardless, this
// only satisfies static analysis (in-editor and via `tsc --noEmit`).
declare module "*.css";
