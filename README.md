# gatsby-source-greenhouse-job-board
> Source plugin for pulling offices, departments, and jobs into Gatsby from the Greenhouse Job Board API. It creates links between offices, departments, and jobs so they can be queried in Gatsby using GraphQL.

## Job Board vs. Harvest API

Greenhouse provides two APIs for sourcing information on open jobs, Harvest and Job Board. For most use-cases around presenting and displaying job posts on a website, et. al, the Job Board API is sufficient and recommended because:

-   No authentication needed, therefore no need to manage secrets. etc.
-   Harvest API provides a significant amount of data which some individuals and/or organizations may consider to be sensitive

More information on the Job Board API can be found on the [Greenhouse Developer Website](https://developers.greenhouse.io/job-board.html).

## Installation

```bash
npm install kevinbarnett/gatsby-source-greenhouse-job-board
```

or

```bash
yarn add kevinbarnett/gatsby-source-greenhouse-job-board
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
