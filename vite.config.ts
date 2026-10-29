import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Relative asset paths, so the build works at its own vercel.app URL and under kevinschaich.com/project/backroads/.
export default defineConfig({
    base: './',
    plugins: [react(), tailwindcss()],
    // MapLibre 6 loads its worker relative to its own module; pre-bundling moves the module and breaks that.
    optimizeDeps: { exclude: ['maplibre-gl'] },
})
