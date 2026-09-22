# Documentation: https://docs.brew.sh/Formula-Cookbook
#                https://rubystyle-guide.org/
class Nikcli < Formula
  desc "AI-native CLI agent that researches, plans, and writes code"
  homepage "https://nikcli-ai.dev"
  license "MIT"
  head "https://github.com/nikcli/nikcli.git", branch: "live-main"

  # Auto-update from GitHub releases
  livecheck do
    url :stable
    strategy :github_latest
    regex(/v?(\d+(?:\.\d+)+)/i)
  end

  # macOS
  on_macos do
    on_arm do
      url "https://github.com/nikcli/nikcli/releases/download/v1.25.0/nikcli-ai-darwin-arm64.zip"
      sha256 "b600616e4fcbe9f8ab58e0b14f97e54d07f86ceecd67ba4681fddfc46a3bee50"
    end
    on_intel do
      url "https://github.com/nikcli/nikcli/releases/download/v1.25.0/nikcli-ai-darwin-x64.zip"
      sha256 "2b291a02bbfcd8b1a529f20cb83a770c91d22ef4f84860587fe299b9e6ef1ade"
    end
  end

  # Linux (GLIBC)
  on_linux do
    on_arm do
      url "https://github.com/nikcli/nikcli/releases/download/v1.25.0/nikcli-ai-linux-arm64.tar.gz"
      sha256 "25ff5a6e2d8cef92e0bfdd1905906bb64569c10479d9b967e87bda1f4970feb6"
    end
    on_x86_64 do
      url "https://github.com/nikcli/nikcli/releases/download/v1.25.0/nikcli-ai-linux-x64.tar.gz"
      sha256 "a0fd982cb15e1aaeec96a4886342240b2b7d379715ccd08b3561dbff62bf915c"
    end
  end

  def install
    bin.install "nikcli"
  end

  test do
    system "#{bin}/nikcli", "--version"
  end
end