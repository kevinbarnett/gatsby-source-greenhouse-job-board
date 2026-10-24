# gatsby-source-greenhouse-job-board
> Source plugin for pulling offices, departments, and jobs into Gatsby from the Greenhouse Job Board API. It creates links between offices, departments, and jobs so they can be queried in Gatsby using GraphQL.

## Requirements

- **Gatsby**: 5
- **Node.js**: 18 or later, but Gatsby 5.16 only supports up to 25.
  Use 22 or 24, since Node.js 18 and 20 no longer get security fixes.

## Installation

```bash
npm install gatsby-source-greenhouse-job-board
```

or

```bash
yarn add gatsby-source-greenhouse-job-board
```

If you're upgrading from v1, follow the [migration guide](MIGRATION.md).

## Usage

To use this source you need to provide a Greenhouse Job Board token.
It is the last part of your job board's URL, `https://job-boards.greenhouse.io/{board token}`.
To find it in Greenhouse, go to `Configure > Job Boards & Posts`, choose `Edit Board Settings` in the menu next to your job board, and look in the `URL` section.

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
| `timeout` | No | How many milliseconds to wait for each request to Greenhouse before trying it again. A whole number from 1 to 2147483647. Defaults to `90000`, which is 90 seconds. See [Timeouts](#timeouts). |

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
A job without a department or office has `null` for `departments` or `offices`.

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
        metadata {
          name
          value_type
          value
        }
      }
    }
  }
}
```

**Note**: `content` is the job description as HTML, escaped the way the API sends it (for example `&lt;p&gt;`).
Anyone who can edit job posts in Greenhouse controls this HTML.
Decode it and run it through an HTML sanitizer before rendering it with `dangerouslySetInnerHTML`.

#### Metadata

`metadata` lists the values of the board's custom fields, with `id`, `name`, `value_type` and `value`, which a site can query on every board.
A job without custom fields has `null` for `metadata`.
Gatsby infers the type of `value` from the values that Greenhouse sends for the board.
Where they all have one type, such as strings, `value` has that type.
A value of another type is `null` in query results, such as an empty list among strings, which Greenhouse sends for a multi-select field without a value.
Filters see each value as Greenhouse sends it, so `value: { eq: null }` does not match an empty list.
Where the values have different types, such as `true` and `"Remote"`, or no job has custom fields, `value` is `JSON`, and each value comes back as Greenhouse sends it.

### Query departments

Department data links to `jobs` from which all data mentioned in the previous example can be queried.
Departments can also have parent/child relationships which are linked when available.
A department without jobs has `null` for `jobs`.
Its sub-departments are also in `childrenGreenhouseDepartment`, a list that is empty for a department without any, which a site can query on every board.

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

Office data links to both `departments` and `jobs` from which all data mentioned in the previous examples can be queried.
Offices can also have parent/child relationships which are linked when available.
An office without departments has `null` for `departments`, and an office with departments has a list of `jobs`, which is empty when none of its departments has jobs.
Its sub-offices are also in `childrenGreenhouseOffice`, a list that is empty for an office without any, which a site can query on every board.

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

More information on the Job Board API can be found on the [Greenhouse Developer Website](https://docs.greenhouse.io/job-board.html).

## Request limits

The plugin sends one request for each job, plus three for each board.
Greenhouse blocks an IP address for about a minute once it gets a few thousand requests from it within a minute, and the build then fails with HTTP status 403.
To stay well below that, the plugin sends at most 2,000 requests a minute by default, counting every board in the build.
A build that fetches more than about 2,000 jobs then takes about a minute longer for every further 2,000 jobs, instead of failing.
The plugin retries timeouts, network errors, HTTP status 429 and server errors up to 3 times, but not 403, since a block lasts longer than the retries would wait.
When Greenhouse lists a job but no longer has its details, usually because the job closed during the build, the plugin leaves the job out and warns about it.
The job is also left out of the `jobs` of its departments and offices, so a department whose only job closed has an empty list.
If that happens to more than half of the jobs, the build fails instead, since Greenhouse is then more likely failing than closing jobs.
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

## Timeouts

Greenhouse can take about a minute to send the offices list of a big board when it has not sent that list for a while.
So the plugin waits up to 90 seconds for each request before it tries the request again.
It tries each request up to 4 times, so with the default timeout, a request that Greenhouse never answers fails the build after about 6 minutes.

If a build fails because a request "timed out", set the `timeout` option to a longer time, in milliseconds:

```js
options: {
  boardToken: '{board token}',
  timeout: 180000,
},
```

## Development

Sites can use the plugin on Node.js 18 and later, but working on the plugin needs Node.js 22 or later, which `devEngines` in `package.json` enforces, since the tests rely on features of the Node.js test runner that older versions lack.

```bash
npm install
npm test
npm run test:e2e
```

`npm test` runs the unit tests in `src/__tests__`.
`npm run test:e2e` packs the plugin the way npm publishes it, and builds the Gatsby site in `e2e/site` with it, against a mock of the Greenhouse API.

## License

MIT, see [LICENSE](LICENSE).
