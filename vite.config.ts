import { defineConfig, type Plugin } from "vite";
import { resolve } from "path";

// 开发模式下强制 Vite 注入的所有元素透明
function transparentPlugin(): Plugin {
  return {
    name: "force-transparent",
    transformIndexHtml(html) {
      // 在 </head> 前注入重置样式，覆盖 Vite 客户端可能添加的背景
      return html.replace(
        "</head>",
        `<style>
/* 强制所有 Vite 注入元素透明 */
vite-error-overlay,
vite-error-overlay *,
#vite-error-overlay,
div[style*="background"] {
  background: transparent !important;
}
</style></head>`
      );
    },
  };
}

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [transparentPlugin()],
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    hmr: {
      overlay: false,
    },
  },
});
