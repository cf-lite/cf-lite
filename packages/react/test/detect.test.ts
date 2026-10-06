import { describe, expect, it } from "vitest";
import { classifyModule, detectIslands } from "../src/detect.js";

const kinds = (src: string, o?: object) => Object.fromEntries(classifyModule(src, "x.tsx", o).map((v) => [v.name, v.kind]));

describe("classifyModule", () => {
  it("static / ssr / island", () => {
    expect(kinds(`export function A() { return <p>hi</p>; }
      export function B() { const c = useContext(X); return <p>{c}</p>; }
      export function C() { const [n, setN] = useState(0); return <b>{n}</b>; }
      export const D = () => <button onClick={() => 1}>x</button>;`)).toEqual({ A: "static", B: "ssr", C: "island", D: "island" });
  });
  it("custom hooks are client-side unless listed; kit hooks via options", () => {
    expect(kinds(`export function A() { const x = useContent(); return <p>{x}</p>; }`)).toEqual({ A: "island" });
    expect(kinds(`export function A() { const x = useContent(); return <p>{x}</p>; }`, { serverHooks: ["useContent"] })).toEqual({ A: "ssr" });
  });
  it("browser globals count, shadowed names and property names do not", () => {
    expect(kinds(`export function A() { return <p>{window.innerWidth}</p>; }`)).toEqual({ A: "island" });
    expect(kinds(`export function A({ location }: { location: string }) { return <p>{location}</p>; }`)).toEqual({ A: "static" });
    expect(kinds(`export function A(p: { a: { location: string } }) { return <p>{p.a.location}{JSON.stringify({ location: 1 })}</p>; }`)).toEqual({ A: "static" });
  });
  it('"use client" makes every component an island; types are ignored', () => {
    expect(kinds(`"use client";\nexport function A() { return <p />; }`)).toEqual({ A: "island" });
    expect(kinds(`type T = typeof window;\nexport function A(): JSX.Element { return <p />; }`)).toEqual({ A: "static" });
  });
  it("reasons carry line numbers", () => {
    const [v] = classifyModule(`export function A() {\n  const [n] = useState(0);\n  return <p>{n}</p>;\n}`);
    expect(v!.reasons).toEqual(["useState() at line 2"]);
  });
});

describe("detectIslands", () => {
  it("reports exported islands only (default, named, export list)", () => {
    const src = `import { useState } from "react";
      function Inner() { const [a] = useState(1); return <i>{a}</i>; }
      function Hidden() { const [a] = useState(1); return <i>{a}</i>; }
      export function Plain() { return <p />; }
      export default Inner;
      export const Btn = () => <button onClick={() => 1} />;
      export { Hidden as Renamed };`;
    const r = detectIslands(src, "x.tsx")!;
    expect(r).toHaveLength(3);
    expect(r).toEqual(expect.arrayContaining([{ export: "Btn", strategy: "visible" }, { export: "default", strategy: "visible" }, { export: "Renamed", strategy: "visible" }]));
  });
  it("an interactive component that takes children is skipped with a reason", () => {
    const r = detectIslands(`export function Box({ children }) { const [o] = useState(0); return <div>{o}{children}</div>; }`, "x.tsx")!;
    expect(r).toHaveLength(1);
    expect(r[0]!.strategy).toBeUndefined();
    expect(r[0]!.skip).toMatch(/children/);
    const p = detectIslands(`export function Box(props) { const [o] = useState(0); return <div>{o}{props.children}</div>; }`, "x.tsx")!;
    expect(p[0]!.skip).toMatch(/children/);
  });
  it("null for modules with nothing interactive or no components", () => {
    expect(detectIslands(`export function A() { return <p />; }`, "x.tsx")).toBeNull();
    expect(detectIslands(`export const x = useState;`, "x.tsx")).toBeNull();
  });
});
