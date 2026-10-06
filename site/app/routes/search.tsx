import { Shell } from "../components/Shell";
import { Search } from "../components/Search";

// The only page on the site that ships JS: hydrate = true mounts the Search island; the index is fetched lazily after mount.
export const render = "static";
export const hydrate = true;
export const head: { title: string; meta: Record<string, string>[] } = {
  title: "Search · cf-lite docs",
  meta: [{ name: "description", content: "Search the cf-lite documentation." }, { name: "robots", content: "noindex" }, { property: "og:title", content: "Search · cf-lite docs" }],
};

export default function SearchPage() {
  return (
    <Shell>
      <main id="main" class="doc">
        <h1>Search</h1>
        <Search />
        <noscript><p>Search needs JavaScript (a small index is loaded on this page only). Without it, use the menu, or your browser's find-in-page on a docs page.</p></noscript>
      </main>
    </Shell>
  );
}
