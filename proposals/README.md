# SFML change proposals

Changes to the SFML specification are made through proposals. A proposal is a single Markdown file
in this directory, named `NNNN-short-slug.md`, where `NNNN` is the next unused number.

## The shortest version of the process

1. **Explore the problem.** Check that others have it too. A proposal that solves a problem only one
   factory has is a proposal for a harness feature.
2. **Build a prototype.** Something that runs, even badly. The prototype is where the design gets
   its edges knocked off.
3. **Write the proposal**, based on what the prototype taught you. Copy
   [`TEMPLATE.md`](./TEMPLATE.md) and fill in every section.
4. **Open a pull request.** Discussion happens on the PR.

Proposals that argue from a prototype move faster than proposals that argue from first principles,
because the interesting objections to a pipeline format are almost always about what happens on the
second pass, on resume, or under concurrency — and those are cheaper to observe than to reason
about.

## What makes a proposal likely to land

- It keeps the core small and puts what a runtime may vary behind a declared extension point.
- It prefers a syntactic rule the linter can enforce over a semantic rule it can only hope for.
- It ships a decision procedure with every validation rule it adds. A rule that cannot be checked is
  a comment and should be written as one.
- It says what it costs, not only what it buys.

## Status values

| Status     | Meaning                                                     |
| ---------- | ----------------------------------------------------------- |
| `draft`    | Being written; not yet asking for a decision                |
| `proposed` | Open for review                                             |
| `accepted` | Agreed; the specification change has not landed yet         |
| `landed`   | In the specification and the schema                         |
| `declined` | Not proceeding; the file stays as a record of the reasoning |
