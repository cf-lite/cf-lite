"use client";
export default function Err({ digest }: { digest?: string }) { return <main id="err-boundary"><h1>custom rsc error</h1><p id="err-digest">{digest}</p></main>; }
