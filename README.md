# Breaking the Ice: 3D Modeling Decades of Change - SAP Version

Breaking the Ice is an interactive science exhibit designed for pupils, teachers, and the public. It combines:

1. A 3D visualization showing the evolution of Arctic sea ice thickness over time.
2. A 2D quiz game with scientific questions related to sea ice and climate change.

The stand is designed for touch interaction (tablets, iPads, or touchscreen laptops), supported by a pull-up banner and live facilitators.

**Live demo:** [https://sap.breakingtheice.space/](https://sap.breakingtheice.space/)

### Learning Goals

Visitors should leave with:

1. Better awareness of climate change and its impact on oceans.
2. Stronger scientific inquiry skills through scenario-based questioning.
3. Better understanding of human impact on marine ecosystems.

## Project Overview

This repository contains the frontend for the interactive experience, built with Next.js and exported as a static site for GitHub Pages.

## Run Locally

### Prerequisites

1. Node.js 20+
2. npm

### Install dependencies

```bash
npm ci
```

## Dependency Patches

This project uses `patch-package` to persist a local fix for `@carbonplan/zarr-layer`.

1. Patch file: `patches/@carbonplan+zarr-layer+0.5.0.patch`
2. Applied automatically via the `postinstall` script in `package.json`

If the `@carbonplan/zarr-layer` version changes, regenerate the patch for the new version.

### Start development server

```bash
npm run dev
```

Open http://localhost:3000 in your browser.

## Build, Format, and Lint

### Build

```bash
npm run build
```

Build generates a production-ready static export in the out folder.

### Format

```bash
npm run format
```

Use this to normalize style and reduce noisy diffs.

### Format check (CI-friendly)

```bash
npm run format:check
```

### Lint

```bash
npm run lint
```

Lint catches potential bugs, accessibility issues, and consistency problems.

### Why these checks matter before pushing to GitHub

Running build, format checks, and lint before push helps you:

1. Catch failures early (before CI fails on main).
2. Keep code consistent and easier to review.
3. Reduce risk of broken deployments to GitHub Pages.

Recommended pre-push sequence:

```bash
npm run format:check
npm run lint
npm run build
```

## CI and Deployment

This project deploys through GitHub Actions using:

1. Workflow: .github/workflows/nextjs.yml
2. Trigger: push to main (and manual workflow_dispatch)
3. Build output: out
4. Deployment target: GitHub Pages

## Images and Assets

Assets are managed in two layers:

1. Static files live in the public folder (png, svg, etc.).
2. Application references use a centralized map in app/components/assets.ts.

The assets map prepends NEXT_PUBLIC_BASE_PATH so paths continue to work in static export/deployment contexts.

Example pattern:

1. Add file to public/
2. Register it in app/components/assets.ts
3. Use it from components via ASSETS.<name>

This keeps paths consistent and avoids hardcoding strings across multiple components.

## Updating Questions

Quiz content is driven by:

1. Data file: app/data/questions.json
2. Type definition: app/types/quiz.ts
3. Rendering component: app/components/QuestionsStage.tsx

### Question JSON shape

Each question object should include:

1. id: unique string (for example q1)
2. title: displayed heading
3. scenario: explanatory paragraph
4. question: the actual prompt
5. imageSource: Image source
6. options: array of 3 option objects (See Option Object Description below)
7. correctIndex: zero-based index of the correct option
8. bg: stage background color (hex)
9. media: optional array of one or two image paths (See Media Object Description below)


Each option object currently supports:

1. image: optional image path
2. text: option label shown on the card
3. explanation: feedback text for learning context
4. width: width of the image
5. height: height of the image

Each media object currently supports:
1. image: optional image path
2. position: position of the image (front or back)
3. transform: rotation of the image
4. width: width of the image
5. height: height of the image

### Adding or changing question option images

1. Add new image files or modify existing ones in the public folder
2. Reference them in app/data/questions.json using paths like /my_image.png
3. Update the width and height of the option image in the options array accordingly

### Adding or changing question media images

1. Add new image files or modify existing ones in the public folder
2. Reference them in app/data/questions.json using paths like /my_image.png
3. For media pairs, place them in the media array in the order you want them layered
4. Update the width and height of the image in the media array accordingly


### Quick validation after updating questions

Run these commands before pushing:

```bash
npm run format:check
npm run lint
npm run build
```
