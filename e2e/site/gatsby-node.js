const fs = require('node:fs')

// Declares the types in E2E_TYPE_DEFS, if any, the way a site declares types of its own
exports.createSchemaCustomization = ({ actions }) => {
  if (process.env.E2E_TYPE_DEFS) {
    actions.createTypes(process.env.E2E_TYPE_DEFS)
  }
}

// Runs the queries in E2E_QUERIES one after another, the way a site queries its data while creating
// pages, and saves their results to E2E_RESULTS
exports.createPages = async ({ graphql }) => {
  const results = []
  for (const { query, variables } of JSON.parse(process.env.E2E_QUERIES)) {
    results.push(await graphql(query, variables))
  }
  fs.writeFileSync(process.env.E2E_RESULTS, JSON.stringify(results, null, 2))
}
