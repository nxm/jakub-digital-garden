{
  description = "jakub.app – a digital garden (Bun + TypeScript static-site generator)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.bun ];
          shellHook = ''
            echo "engine – bun $(bun --version)"
            echo "  bun install    # install deps"
            echo "  bun run dev    # build + watch + serve http://localhost:3000"
            echo "  bun run build  # one-shot build → dist/"
          '';
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
