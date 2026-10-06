import { posts } from "../../../../server/posts";

// Served at /posts/<slug>/opengraph-image.png (1200x630) by the OG Worker. Fonts: TTF/OTF/WOFF only (not WOFF2).
export const og = { fonts: [{ name: "DejaVu", url: "/fonts/DejaVuSans-Bold.ttf", weight: 700 }] };

export default ({ params }: { params: Record<string, string> }) => (
  <div style={{ display: "flex", width: "100%", height: "100%", background: "#0b5fff", color: "white", padding: 80, fontSize: 72, fontFamily: "DejaVu", alignItems: "center" }}>
    {posts.find((p) => p.slug === params.slug)?.title ?? params.slug}
  </div>
);
