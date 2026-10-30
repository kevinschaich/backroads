import tailwindcss from '@tailwindcss/vite'
import { kevinschaichMap } from '@kevinschaich/components/map/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Relative asset paths, so the build works at its own vercel.app URL and under kevinschaich.com/project/backroads/.
// kevinschaichMap() keeps MapLibre out of pre-bundling (its worker URL) and dedupes React and the components.
export default defineConfig({
    base: './',
    plugins: [react(), tailwindcss(), kevinschaichMap()],
})
