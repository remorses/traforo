{
  description = "traforo - HTTP tunnel via Cloudflare Durable Objects and WebSockets";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [ ];
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      perSystem =
        { pkgs, config, ... }:
        let
          inherit (pkgs) nodejs;
          pnpm = pkgs.pnpm_10;
        in
        {
          packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
            pname = "traforo";
            version = "0.0.7";

            src = ./.;

            nativeBuildInputs = [
              nodejs
              pnpm
              pkgs.pnpmConfigHook
              pkgs.makeWrapper
            ];

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 3;
              hash = "sha256-gknPoCnGgGE5+jInKXdO7KgHQDWUydGF+ulgpfmajTk=";
            };

            buildPhase = ''
              runHook preBuild

              pnpm build

              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p $out/lib/traforo $out/bin

              cp -r dist $out/lib/traforo/
              cp package.json $out/lib/traforo/

              # Install production dependencies only
              pnpm install --prod --frozen-lockfile --ignore-scripts
              cp -r node_modules $out/lib/traforo/

              makeWrapper ${nodejs}/bin/node $out/bin/traforo \
                --add-flags "$out/lib/traforo/dist/cli.js"

              runHook postInstall
            '';

            meta = {
              description = "HTTP tunnel via Cloudflare Durable Objects and WebSockets";
              license = pkgs.lib.licenses.mit;
              mainProgram = "traforo";
            };
          });

          apps.default = {
            type = "app";
            program = "${config.packages.default}/bin/traforo";
          };

          devShells.default = pkgs.mkShell {
            buildInputs = [
              nodejs
              pnpm
            ];

            shellHook = ''
               echo "traforo dev shell"
               echo "  node $(node --version) | pnpm $(pnpm --version)"
               echo ""
               echo "Installing dependencies..."
               pnpm install --frozen-lockfile 2>/dev/null || pnpm install
               echo ""
               echo "Available commands:"
              echo "  pnpm dev          - Run Cloudflare worker locally (wrangler dev)"
               echo "  pnpm deploy       - Deploy worker to Cloudflare"
               echo "  pnpm build        - Build the CLI"
               echo "  pnpm cli          - Run CLI from source (tsx)"
               echo "  pnpm test         - Run tests"
            '';
          };
        };
      flake = { };
    };
  # flake-utils.lib.eachDefaultSystem (
  #   system:
  #   let
  #     pkgs = import nixpkgs { inherit system; };
  #     nodejs = pkgs.nodejs;
  #     pnpm = pkgs.pnpm_10;
  #   in
  #   {
  #     packages.default = pkgs.stdenv.mkDerivation (finalAttrs: {
  #       pname = "traforo";
  #       version = "0.0.7";
  #
  #       src = ./.;
  #
  #       nativeBuildInputs = [
  #         nodejs
  #         pnpm
  #         pkgs.pnpmConfigHook
  #         pkgs.makeWrapper
  #       ];
  #
  #       pnpmDeps = pkgs.fetchPnpmDeps {
  #         inherit (finalAttrs) pname version src;
  #         pnpm = pnpm;
  #         fetcherVersion = 3;
  #         hash = "sha256-gknPoCnGgGE5+jInKXdO7KgHQDWUydGF+ulgpfmajTk=";
  #       };
  #
  #       buildPhase = ''
  #         runHook preBuild
  #
  #         pnpm build
  #
  #         runHook postBuild
  #       '';
  #
  #       installPhase = ''
  #         runHook preInstall
  #
  #         mkdir -p $out/lib/traforo $out/bin
  #
  #         cp -r dist $out/lib/traforo/
  #         cp package.json $out/lib/traforo/
  #
  #         # Install production dependencies only
  #         pnpm install --prod --frozen-lockfile --ignore-scripts
  #         cp -r node_modules $out/lib/traforo/
  #
  #         makeWrapper ${nodejs}/bin/node $out/bin/traforo \
  #           --add-flags "$out/lib/traforo/dist/cli.js"
  #
  #         runHook postInstall
  #       '';
  #
  #       meta = {
  #         description = "HTTP tunnel via Cloudflare Durable Objects and WebSockets";
  #         license = pkgs.lib.licenses.mit;
  #         mainProgram = "traforo";
  #       };
  #     });
  #
  #     apps.default = {
  #       type = "app";
  #       program = "${self.packages.${system}.default}/bin/traforo";
  #     };
  #
  #     devShells.default = pkgs.mkShell {
  #       buildInputs = [
  #         nodejs
  #         pnpm
  #       ];
  #
  #       shellHook = ''
  #         echo "traforo dev shell"
  #         echo "  node $(node --version) | pnpm $(pnpm --version)"
  #         echo ""
  #         echo "Installing dependencies..."
  #         pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  #         echo ""
  #         echo "Available commands:"
  #         echo "  pnpm dev          - Run Cloudflare worker locally (wrangler dev)"
  #         echo "  pnpm deploy       - Deploy worker to Cloudflare"
  #         echo "  pnpm build        - Build the CLI"
  #         echo "  pnpm cli          - Run CLI from source (tsx)"
  #         echo "  pnpm test         - Run tests"
  #       '';
  #     };
  #   }
  # );
}
