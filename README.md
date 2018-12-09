# gatsby-source-greenhouse-job-board
> Source plugin for pulling offices, departments, and jobs into Gatsby from the Greenhouse Job Board API. It creates links between offices, departments, and jobs so they can be queried in Gatsby using GraphQL.

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

```
{
  ...
  plugins: [
    ...
    {
      resolve: 'gatsby-source-greenhouse-job-board',
      options: {
        boardToken: '{board token}'
      },
  ]
}
```

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

Three standard data types will be available from Greenhouse: Office, Department and Job.

For each data type, `greenhouse${typeName}` and
`allGreenhouse${typeName}` is made available. Relationships between nodes are provided as node fields as described below.

**Note**: The following examples are not a complete reference to the available
fields for each node. Utilize Gatsby's built-in GraphQL tool to discover the
types and properties available.

### Query jobs

Jobs are linked to their `departments` and `offices`, which following the format of the API, returns an array. 

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

### Query departments

Department data links to `jobs` from which all data mentioned in the previous example can be queried. Departments can also also have parent/child relationships which are linked when available.

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

Office data links to both `departments` and `jobs` from which all data mentioned in the previous examples can be queried. Offices can also also have parent/child relationships which are linked when available.

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
