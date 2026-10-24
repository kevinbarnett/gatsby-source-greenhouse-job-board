// Loaded into the Gatsby build with --require, so the build never reaches the real Greenhouse API.
// GREENHOUSE_MOCK names a JSON file that maps each request path to a { status, body } response.
// Any other request fails.
const fs = require('node:fs')

const routes = JSON.parse(fs.readFileSync(process.env.GREENHOUSE_MOCK, 'utf8'))

globalThis.fetch = async url => {
  const { origin, pathname, search } = new URL(url)
  const route = origin === 'https://boards-api.greenhouse.io' && routes[pathname + search]
  if (!route) {
    throw new Error(`The Greenhouse mock has no response for ${url}`)
  }
  return Response.json(route.body, { status: route.status })
}
