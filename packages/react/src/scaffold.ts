import type { AdapterScaffold } from "cf-lite/adapter";

export const scaffold: AdapterScaffold = {
  deps: { react: "^19.3.0", "react-dom": "^19.3.0" },
  devDeps: { "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0" },
  tsconfig: { compilerOptions: { jsx: "react-jsx" } },
  entry: {
    file: "app/main.tsx",
    content: `import { mount } from "@cf-lite/react/client";\nimport { routes } from "../.cf-lite/routes";\n\nmount(routes);\n`,
  },
  starter: {
    "app/routes/_layout.tsx": `import type { ReactNode } from "react";\nimport { Link } from "@cf-lite/react/client";\n\nexport const head = { meta: [{ name: "description", content: "cf-lite app" }] };\n\nexport default function Layout({ children }: { children?: ReactNode }) {\n  return (\n    <div>\n      <nav><Link to="/">home</Link></nav>\n      {children}\n    </div>\n  );\n}\n`,
    "app/routes/index.tsx": `import { useState } from "react";\n\nexport const head = { title: "Home" };\n\nexport default function Home() {\n  const [n, setN] = useState(0);\n  return <main><h1>Hello from cf-lite + React</h1><button onClick={() => setN(n + 1)}>clicked {n}</button></main>;\n}\n`,
  },
};
export default scaffold;
