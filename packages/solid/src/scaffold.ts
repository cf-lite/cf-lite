import type { AdapterScaffold } from "cf-lite/adapter";

export const scaffold: AdapterScaffold = {
  deps: { "solid-js": "^1.9.15" },
  // solid-js 1.9.x pins seroval ~1.5 (GHSA-p6vx-979v-rg4c, GHSA-jp82-f5mq-hwhp, fixed in 1.6.3); 1.6.x is API-compatible
  overrides: { seroval: "^1.6.3", "seroval-plugins": "^1.6.3" },
  tsconfig: { compilerOptions: { jsx: "preserve", jsxImportSource: "solid-js" } },
  entry: {
    file: "app/main.tsx",
    content: `import { mount } from "@cf-lite/solid/client";\nimport { routes } from "../.cf-lite/routes";\n\nmount(routes);\n`,
  },
  starter: {
    "app/routes/_layout.tsx": `import type { JSX } from "solid-js";\nimport { Link } from "@cf-lite/solid/client";\n\nexport const head = { meta: [{ name: "description", content: "cf-lite app" }] };\n\nexport default function Layout(props: { children?: JSX.Element }) {\n  return (\n    <div>\n      <nav><Link to="/">home</Link></nav>\n      {props.children}\n    </div>\n  );\n}\n`,
    "app/routes/index.tsx": `import { createSignal } from "solid-js";\n\nexport const head = { title: "Home" };\n\nexport default function Home() {\n  const [n, setN] = createSignal(0);\n  return <main><h1>Hello from cf-lite + Solid</h1><button onClick={() => setN(n() + 1)}>clicked {n()}</button></main>;\n}\n`,
  },
};
export default scaffold;
