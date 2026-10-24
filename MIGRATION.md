# Migrating from v1 to v2

Version 2.0.0, released in November 2025, made these breaking changes:

- It needs Gatsby 5, while version 1 supported Gatsby 2, 3 and 4.
- It needs Node.js 18 or later.
- Gatsby node ids (`id`) have a new format, so an id saved from a v1 build no longer matches any node.
  Version 1 made ids such as `Greenhouse__Job__123`, and version 2 lets Gatsby make them from the type and the Greenhouse id.

Each node keeps its Greenhouse id in `gh_Id`, as in version 1.
Version 2.0.0 left `gh_Id` out, and 2.1.0 brought it back, so upgrade straight to 2.1.0 or later.

## Steps

1. Upgrade the site to Gatsby 5, following Gatsby's [migration guide](https://www.gatsbyjs.com/docs/reference/release-notes/migrating-from-v4-to-v5/).

2. Use Node.js 22 or 24, since Node.js 18 and 20 no longer get security fixes, and Gatsby 5.16 does not support Node.js 26.
   With nvm:
   ```bash
   nvm install 24
   nvm use 24
   ```

3. Update the plugin:
   ```bash
   npm install gatsby-source-greenhouse-job-board@^2.1.0
   ```

4. Find node ids that the site hardcodes or saves, for example by searching its code for `Greenhouse__`, and look the nodes up by `gh_Id` instead:
   ```graphql
   {
     greenhouseJob(gh_Id: { eq: 123 }) {
       title
     }
   }
   ```
   Page paths that the site builds from node ids change too.
   Build them from `gh_Id` instead, and add redirects from the old paths if links to them need to keep working.

5. Run `gatsby develop`, open <http://localhost:8000/___graphql>, and run the site's queries to check that they still work.
