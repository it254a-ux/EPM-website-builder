import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';

export default defineConfig({
  plugins: [pluginReact()],
  html: {
    title: 'EPM — Executive Prime Markets',
    meta: {
      description:
        'Build, brand, and grow your own trading platform with EPM.',
    },
  },
});
