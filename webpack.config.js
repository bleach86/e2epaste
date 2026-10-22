const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const CompressionPlugin = require("compression-webpack-plugin");

// Every js/tools/pages/<slug>.mjs becomes the bundle tools/<slug>.js, loaded
// by templates/tool_layout.html.j2.
const toolEntries = Object.fromEntries(
  fs
    .readdirSync(path.resolve(__dirname, "js/tools/pages"))
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => [`tools/${path.basename(file, ".mjs")}`, `./js/tools/pages/${file}`]),
);

// Stylesheets from npm packages, copied into the output as they are
// (layout.html.j2 links them from /public/js/dist/vendor/), with Bootstrap's
// source map, which its stylesheet names.
const VENDOR_FILES = {
  "vendor/bootstrap.min.css": "node_modules/bootstrap/dist/css/bootstrap.min.css",
  "vendor/bootstrap.min.css.map": "node_modules/bootstrap/dist/css/bootstrap.min.css.map",
  "vendor/atom-one-dark.min.css": "node_modules/highlight.js/styles/atom-one-dark.min.css",
};

class CopyVendorFiles {
  apply(compiler) {
    const { Compilation, sources } = compiler.webpack;
    compiler.hooks.thisCompilation.tap("CopyVendorFiles", (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: "CopyVendorFiles", stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
        () => {
          for (const [to, from] of Object.entries(VENDOR_FILES)) {
            const file = path.resolve(__dirname, from);
            compilation.fileDependencies.add(file);
            // Already minified: the minifier leaves them (and their licence
            // headers) as they are.
            compilation.emitAsset(to, new sources.RawSource(fs.readFileSync(file)), { minimized: true });
          }
        },
      );
    });
  }
}

// One bundle per page, plus `common` which layout.html.j2 loads everywhere.
// Templates reference them as /public/js/dist/<name>.js?v={{ asset_version }}.
module.exports = {
  mode: process.env.NODE_ENV === "development" ? "development" : "production",
  entry: {
    common: "./js/common.mjs",
    create: "./js/pages/create.mjs",
    paste: "./js/pages/paste.mjs",
    share: "./js/pages/share.mjs",
    delete: "./js/pages/delete.mjs",
    ...toolEntries,
  },
  output: {
    path: path.resolve(__dirname, "static/js/dist"),
    publicPath: "/public/js/dist/",
    filename: "[name].js",
    // Lazily loaded chunks (e.g. the zxcvbn dictionaries) aren't referenced
    // from templates, so they carry a content hash for cache busting instead.
    chunkFilename: "chunks/[name].[contenthash].js",
    clean: true,
  },
  devtool: "source-map",
  // Only warn about the size of bundles pages load up front; lazy chunks like
  // the zxcvbn dictionaries are expected to be large.
  performance: {
    assetFilter: (file) => file.endsWith(".js") && !file.startsWith("chunks/"),
  },
  // Precompressed copies (<file>.br, <file>.gz) that the dist_asset route in
  // main.rs serves to browsers that accept them. Skipped for small files and
  // when compression saves less than 20%.
  plugins: [
    new CopyVendorFiles(),
    new CompressionPlugin({
      filename: "[path][base].br",
      algorithm: "brotliCompress",
      test: /\.(js|css)$/,
      compressionOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } },
      threshold: 1024,
    }),
    new CompressionPlugin({
      filename: "[path][base].gz",
      algorithm: "gzip",
      test: /\.(js|css)$/,
      compressionOptions: { level: 9 },
      threshold: 1024,
    }),
  ],
};
