const path = require("path");

// One bundle per page, plus `common` which layout.html.j2 loads everywhere.
// Templates reference them as /public/js/dist/<name>.js?v={{ asset_version }}.
module.exports = {
  mode: process.env.NODE_ENV === "development" ? "development" : "production",
  entry: {
    common: "./js/common.mjs",
    create: "./js/pages/create.mjs",
    paste: "./js/pages/paste.mjs",
    share: "./js/pages/share.mjs",
  },
  output: {
    path: path.resolve(__dirname, "static/js/dist"),
    filename: "[name].js",
    clean: true,
  },
  devtool: "source-map",
};
