# gatsby-source-greenhouse-job-board
> Source plugin for pulling offices, departments, and jobs into Gatsby from the Greenhouse Job Board API. It creates links between offices, departments, and jobs so they can be queried in Gatsby using GraphQL.

## ⚠️ Breaking Changes in v2.0.0

**Version 2.0.0 introduces breaking changes.** If you're upgrading from v1.x, please review the [Migration Guide](#migration-guide-v1-to-v2) below.

**Key Changes:**
- **Gatsby 5+ only** - Support for Gatsby 2, 3, and 4 has been removed
- **Node.js 18+ required** - Minimum Node.js version increased from 14.15.0 to 18.0.0
- **Node IDs may change** - If you have hardcoded node ID references, they may need updating
- **Removed dependencies** - `axios`, `gatsby-node-helpers` removed

## Requirements

- **Gatsby**: ^5.0.0
- **Node.js**: >=18.0.0

## Installation

```bash
npm install gatsby-source-greenhouse-job-board
```

or

```bash
yarn add gatsby-source-greenhouse-job-board
```

## Usage

To use this source you need to provide a Greenhouse Job Board token. You can find this token by logging into Greenhouse and going to `Configure > Dev Center > Configure Job Board`. It will be listed next to the heading 'Your Board Token'.

Next, edit `gatsby-config.js` to use the plugin:

```js
module.exports = {
  plugins: [
    {
      resolve: 'gatsby-source-greenhouse-job-board',
      options: {
        boardToken: '{board token}',
      },
    },
  ],
}
```

### Options

| Option | Required | Description |
| --- | --- | --- |
| `boardToken` | Yes | Your Greenhouse Job Board token. |
| `requestsPerMinute` | No | The most requests to send to Greenhouse in any minute, counting every board in the build. A whole number of at least 1. Defaults to `2000`. See [Request limits](#request-limits). |

## How to query

You can query nodes created from the Greenhouse Job Board API using GraphQL like the following:

**Note**: Learn to use the GraphQL tool and Ctrl+Spacebar at
<http://localhost:8000/___graphql> to discover the types and properties of your
GraphQL model.

```graphql
{
  allGreenhouseJob {
    edges {
      node {
        title
        absolute_url
        location {
          name
        }
        content
      }
    }
  }
}
```

All Greenhouse data is pulled using the Greenhouse Job Board API. Data is made available in the same structure as
provided by the API, with a few exceptions noted below.

Gatsby uses `id` for its own node id, so each node keeps its Greenhouse id in `gh_Id`.

Three standard data types will be available from Greenhouse: Office, Department and Job.

For each data type, `greenhouse${typeName}` and
`allGreenhouse${typeName}` is made available. Relationships between nodes are provided as node fields as described below.

**Note**: The following examples are not a complete reference to the available
fields for each node. Utilize Gatsby's built-in GraphQL tool to discover the
types and properties available.

### Query jobs

Jobs are linked to their `departments` and `offices`, which are lists, following the format of the API.

```graphql
{
  allGreenhouseJob {
    edges {
      node {
        id
        internal_job_id
        title
        absolute_url
        content
        updated_at(formatString: "ddd, MMMM Do, YYYY")
        questions {
          description
          label
          required
          fields {
            name
            type
          }
        }
        location {
          name
        }
        departments {
          name
        }
        offices {
          name
        }
      }
    }
  }
}
```

**Note**: `content` is the job description as HTML, escaped the way the API sends it (for example `&lt;p&gt;`).
Anyone who can edit job posts in Greenhouse controls this HTML.
Decode it and run it through an HTML sanitizer before rendering it with `dangerouslySetInnerHTML`.

### Query departments

Department data links to `jobs` from which all data mentioned in the previous example can be queried. Departments can also have parent/child relationships which are linked when available.

```graphql
{
  allGreenhouseDepartment {
    edges {
      node {
        id
        name
        parent {
          ...on GreenhouseDepartment {
            name
          }
        }
        children {
          ...on GreenhouseDepartment {
            name
          }
        }
        jobs {
          title
          absolute_url
        }
      }
    }
  }
}
```

### Query offices

Office data links to both `departments` and `jobs` from which all data mentioned in the previous examples can be queried. Offices can also have parent/child relationships which are linked when available.

```graphql
{
  allGreenhouseOffice {
    edges {
      node {
        id
        name
        parent {
          ...on GreenhouseOffice {
            name
          }
        }
        children {
          ...on GreenhouseOffice {
            name
          }
        }
        jobs {
          title
          absolute_url
        }
      }
    }
  }
}
```

## Job Board vs. Harvest API

Greenhouse provides two APIs for sourcing information on open jobs, `Harvest` and `Job Board`. For most use-cases that involve presenting and displaying job posts on a website, the Job Board API is sufficient and recommended because:

-   No authentication is required, therefore no need to manage secrets. etc.
-   Harvest API provides a significant amount of data which some individuals and/or organizations may consider to be sensitive

More information on the Job Board API can be found on the [Greenhouse Developer Website](https://developers.greenhouse.io/job-board.html).

## Request limits

The plugin sends one request for each job, plus three for each board.
Greenhouse blocks an IP address for about a minute once it gets a few thousand requests from it within a minute, and the build then fails with HTTP status 403.
To stay well below that, the plugin sends at most 2,000 requests a minute by default, counting every board in the build.
A build that fetches more than about 2,000 jobs then takes about a minute longer for every further 2,000 jobs, instead of failing.
The plugin retries timeouts, network errors, HTTP status 429 and server errors up to 3 times, but not 403, since a block lasts longer than the retries would wait.
The plugin can only count the requests of its own build, so builds that run at the same time from one IP address, for example on shared CI runners, can still get blocked.
If a build fails with HTTP status 403, wait a minute and build again.

To change the limit, set the `requestsPerMinute` option to a whole number of at least 1:

```js
options: {
  boardToken: '{board token}',
  requestsPerMinute: 1000,
},
```

Lower it if builds often fail with HTTP status 403, for example because other builds send requests from the same IP address at the same time.
Raising it makes builds with thousands of jobs faster, but makes a block more likely.
If a site sources several boards, give each the same limit, since the plugin counts their requests together.

## Migration Guide: v1 to v2

### Prerequisites

Before upgrading, ensure you meet the new requirements:

1. **Upgrade to Gatsby 5+**
   ```bash
   npm install gatsby@^5.0.0
   ```

2. **Upgrade to Node.js 18+**
   ```bash
   # Using nvm (recommended)
   nvm install 18
   nvm use 18
   
   # Or download from nodejs.org
   ```

### Step-by-Step Migration

1. **Update the plugin:**
   ```bash
   npm install gatsby-source-greenhouse-job-board@^2.0.0
   ```

2. **Clear Gatsby cache:**
   ```bash
   gatsby clean
   ```

3. **Verify GraphQL queries:**
   - Start your development server: `gatsby develop`
   - Visit `http://localhost:8000/___graphql`
   - Test your existing queries to ensure they still work
   - **Important**: Node IDs may have changed, so if you filter by `id`, verify the format

4. **Check for hardcoded node IDs:**
   - Search your codebase for any hardcoded Greenhouse node IDs
   - Update them if necessary (node ID format may have changed)

5. **Test error scenarios:**
   - Verify error messages display correctly
   - Test with invalid `boardToken` to ensure proper error handling

### Common Issues

**Issue: Node IDs not found**
- **Solution**: Clear cache and rebuild. Node IDs may have changed format.

**Issue: Build fails with "fetch is not defined"**
- **Solution**: Ensure you're using Node.js 18+. The plugin now uses native `fetch` API.

**Issue: Plugin not found or incompatible**
- **Solution**: Verify you're using Gatsby 5+ and Node.js 18+.




