module.exports = {
  plugins: [
    {
      // installed into node_modules from the packed plugin by e2e/build.test.js
      resolve: 'gatsby-source-greenhouse-job-board',
      options: {
        // set by e2e/build.test.js as JSON, so a test can give it as a number
        boardToken: JSON.parse(process.env.E2E_BOARD_TOKEN),
      },
    },
  ],
}
