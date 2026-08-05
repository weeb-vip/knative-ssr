/**
 * Two artifacts ship from this repo on one version number: the edge proxy image
 * and the Helm chart. Keeping them on the same number is the point — a chart
 * version then always names an edge image that exists, and `X-Cache` debugging
 * doesn't need a lookup table.
 *
 * Shaped after the other weeb-vip Go services (gateway-proxy, anime-api), with
 * two deliberate differences: the build context is `edge/` rather than the repo
 * root, and the chart is version-stamped and committed back.
 */

class SemanticReleaseError extends Error {
  constructor(message, code, details) {
    super();
    Error.captureStackTrace(this, this.constructor);
    this.name = 'SemanticReleaseError';
    this.details = details;
    this.code = code;
    this.semanticRelease = true;
  }
}

// Not derived from the repository name. The cluster has pulled `edge-cache`
// since before this workflow existed, and weeb-argocd pins that name — renaming
// the image here would leave the deployed tag pointing at nothing.
const image = () => `${process.env.DOCKER_IMAGE}`;

module.exports = {
  branches: [{ name: 'main' }],

  verifyConditions: [
    () => {
      if (!process.env.DOCKER_IMAGE) {
        throw new SemanticReleaseError(
          'No DOCKER_IMAGE specified',
          'ENODOCKER_IMAGE',
          'Set DOCKER_IMAGE to the full registry path, e.g. harbor.example.com/org/edge-cache'
        );
      }
    },
    '@semantic-release/github'
  ],

  prepare: [
    // Stamp the chart before the image is built, so a failure here costs a
    // build rather than leaving a pushed image with no chart referencing it.
    {
      path: '@semantic-release/exec',
      cmd: './scripts/set-version.sh ${nextRelease.version}'
    },
    {
      path: '@semantic-release/exec',
      cmd: `docker build edge -t ${image()}:\${nextRelease.version}`
    },
    {
      path: '@semantic-release/exec',
      cmd: `docker tag ${image()}:\${nextRelease.version} ${image()}:latest`
    },
    {
      // [skip ci] because this push is made with a PAT, which would otherwise
      // re-trigger Release on its own commit.
      path: '@semantic-release/git',
      assets: ['charts/ssr-knative/Chart.yaml', 'charts/ssr-knative/values.yaml'],
      message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}'
    }
  ],

  publish: [
    {
      path: '@semantic-release/exec',
      cmd: `docker push ${image()}:\${nextRelease.version}`
    },
    {
      path: '@semantic-release/exec',
      cmd: `docker push ${image()}:latest`
    },
    '@semantic-release/github'
  ]
};
