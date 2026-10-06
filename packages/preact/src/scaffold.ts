import type { AdapterScaffold } from "cf-lite/adapter";

export const scaffold: AdapterScaffold = {
  deps: { preact: "^10.29.0", "preact-render-to-string": "^6.6.0" },
  tsconfig: { compilerOptions: { jsx: "react-jsx", jsxImportSource: "preact" } },
  entry: {
    file: "app/main.tsx",
    content: `import { mount } from "@cf-lite/preact/client";\nimport { routes } from "../.cf-lite/routes";\n\nmount(routes);\n`,
  },
  starter: {
    "app/routes/_layout.tsx": `import type { ComponentChildren } from "preact";\nimport { Link } from "@cf-lite/preact/client";\n\nexport const head = { meta: [{ name: "description", content: "cf-lite app" }] };\n\nexport default function Layout({ children }: { children?: ComponentChildren }) {\n  return (\n    <div>\n      <nav><Link to="/">home</Link></nav>\n      {children}\n    </div>\n  );\n}\n`,
    "app/routes/index.tsx": `import { useState } from "preact/hooks";\n\nexport const head = { title: "Home" };\n\nexport default function Home() {\n  const [n, setN] = useState(0);\n  return <main><h1>Hello from cf-lite + Preact</h1><button onClick={() => setN(n + 1)}>clicked {n}</button></main>;\n}\n`,
  },
};
export default scaffold;
