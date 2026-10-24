const fs = require('node:fs')

// Runs the query in E2E_QUERY the way a site queries its data while creating pages,
// and saves the result to E2E_RESULT
exports.createPages = async ({ graphql }) => {
  const result = await graphql(process.env.E2E_QUERY)
  fs.writeFileSync(process.env.E2E_RESULT, JSON.stringify(result, null, 2))
}
