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

// One bundle per page, plus `common` which layout.html.j2 loads everywhere.
// Templates reference them as /public/js/dist/<name>.js?v={{ asset_version }}.
module.exports = {
  mode: process.env.NODE_ENV === "development" ? "development" : "production",
  entry: {
    common: "./js/common.mjs",
    create: "./js/pages/create.mjs",
    paste: "./js/pages/paste.mjs",
    share: "./js/pages/share.mjs",
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
    new CompressionPlugin({
      filename: "[path][base].br",
      algorithm: "brotliCompress",
      test: /\.js$/,
      compressionOptions: { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } },
      threshold: 1024,
    }),
    new CompressionPlugin({
      filename: "[path][base].gz",
      algorithm: "gzip",
      test: /\.js$/,
      compressionOptions: { level: 9 },
      threshold: 1024,
    }),
  ],
};
