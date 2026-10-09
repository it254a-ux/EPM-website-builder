import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  plugins: [pluginReact()],
  html: {
    tags: [
      { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
      { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' } },
      {
        tag: 'link',
        attrs: {
          rel: 'stylesheet',
          href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:wght@500;600;700&display=swap',
          // Loads without holding the page back: text shows at once in a plain font, then switches when the font arrives.
          media: 'print',
          onload: "this.media='all'",
        },
      },
    ],
    title: 'EPM — Executive Prime Markets',
    meta: {
      description:
        'Launch your own branded, Deriv-powered trading platform with EPM. Free to start, no coding required.',
    },
  },
});
