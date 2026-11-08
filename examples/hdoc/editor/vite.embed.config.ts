import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist-embed',
    lib: { entry: {'hcd-editor':'src/embed.tsx',ai:'src/ai/index.ts','inline-containers':'src/inline-containers.ts'}, formats: ['es'], fileName: (_format,name)=>`${name}.js`,cssFileName:'hcd-editor' },
    // Public Slice/Node/Plugin APIs must share the host's ProseMirror classes.
    rollupOptions: { external: id=>['react', 'react-dom', 'react/jsx-runtime'].includes(id)||/^@tiptap\/pm(?:\/|$)/.test(id) },
  },
})
