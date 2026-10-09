"use client";

import React from "react";
import { Github, Twitter, BookOpen } from "lucide-react";
import Link from "next/link";
import { SITE_LINKS } from "@lib/constant";

export default function Footer() {
  return (
    <footer className="w-full border-t border-white/[0.06] bg-base-200/60 mt-10">
      <div className="max-w-7xl mx-auto px-6 py-6 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-base-content/45">
        {/* Left: App Info */}
        <div className="flex items-center gap-2">
          <span>© {new Date().getFullYear()} ArchAngel Bot</span>
          <span className="hidden sm:inline">
            • Built for Solana Meme Traders
          </span>
        </div>

        {/* Right: Social Links */}
        <div className="flex items-center gap-5">
          <Link
            href={SITE_LINKS.docs}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary transition-colors flex items-center gap-1"
          >
            <BookOpen size={16} />
            Docs
          </Link>
          <Link
            href={SITE_LINKS.twitter}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary transition-colors flex items-center gap-1"
          >
            <Twitter size={16} />
            Twitter
          </Link>
          <Link
            href={SITE_LINKS.github}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-primary transition-colors flex items-center gap-1"
          >
            <Github size={16} />
            GitHub
          </Link>
        </div>
      </div>
    </footer>
  );
}
