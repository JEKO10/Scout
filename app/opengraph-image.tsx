import { ImageResponse } from "next/og";

// The social sharing card for every page without its own image
export const alt = "Scout — Find the right conversations. Grow your audience.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#ffffff",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 16,
              background: "#111111",
              color: "#ffffff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 38,
              fontWeight: 700,
            }}
          >
            S
          </div>
          <div style={{ fontSize: 40, fontWeight: 700, color: "#111111" }}>Scout</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 700, color: "#101011", letterSpacing: -3, lineHeight: 1.02 }}>
            Find the right conversations. Grow your audience.
          </div>
          <div style={{ fontSize: 30, color: "#6e6e73", lineHeight: 1.35 }}>
            Scout finds conversations on X where your expertise matters, and helps you reply with something worth
            saying.
          </div>
        </div>
        <div style={{ fontSize: 24, color: "#6e6e73" }}>Free beta · for X</div>
      </div>
    ),
    size,
  );
}
