module.exports = {
  plugins: [
    {
      // installed into node_modules from the packed plugin by e2e/build.test.js
      resolve: 'gatsby-source-greenhouse-job-board',
      // set by e2e/build.test.js as JSON, so a test can give the board token as a number
      options: JSON.parse(process.env.E2E_PLUGIN_OPTIONS),
    },
  ],
}
