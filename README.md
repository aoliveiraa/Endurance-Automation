# Endurance Automation v2.0.0

## New memory analysis

For every `Process - Private Bytes` chart, the tool reads each process series and compares the first and last valid samples.

- LOW: increase up to and including 100 MB
- MEDIUM: increase greater than 100 MB and up to and including 550 MB
- HIGH: increase greater than 550 MB

Low-only tabs and Handle Count tabs are closed automatically. Medium and High tabs remain open and can be focused from the **Open chart** button.

## Supported chart data sources

1. Highcharts
2. Chart.js
3. HTML data tables with process/name and value/memory columns

If the report uses another chart implementation, the tab remains open and the UI reports `Not analyzed`; it is never classified from guessed visual pixels.

## Run

```bat
npm install
npm start
```

## Validate JavaScript

```bat
npm run check
```

## Build portable package

```bat
npm run build:portable
```
