module.exports = {
  // set by e2e/build.test.js as a JSON list of plugin options, so a test can give the board token as
  // a number, and add the plugin once for each board, like a site that sources several boards
  plugins: JSON.parse(process.env.E2E_PLUGIN_OPTIONS).map(options => ({
    // installed into node_modules from the packed plugin by e2e/build.test.js
    resolve: 'gatsby-source-greenhouse-job-board',
    options,
  })),
}
