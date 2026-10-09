"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { SITE_LINKS } from "@lib/constant";

const Navbar = () => {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Wait for client-side mount to render wallet button
  useEffect(() => {
    setMounted(true);
  }, []);

  // Close the mobile menu on route change so it doesn't stay open after
  // navigating (menuOpen otherwise persists across a Link click's re-render).
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const navLinks = [
    { name: "Home", path: "/" },
    { name: "Trading", path: "/trading" },
    { name: "Old Tokens", path: "/trading/old-tokens" },
    { name: "Portfolio", path: "/portfolio" },
    { name: "Settings", path: "/settings" },
    { name: "Docs", path: SITE_LINKS.docs },
  ];

  // /trading/old-tokens starts with "/trading", so naive prefix-matching
  // marked both the "Trading" and "Old Tokens" pills active at once — two
  // elements sharing the same layoutId, fighting over the same slide-in
  // animation. Only the single longest-matching nav path wins.
  const internalPaths = navLinks
    .map((l) => l.path)
    .filter((p) => !p.startsWith("http"));
  const activePath = internalPaths
    .filter((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p)))
    .sort((a, b) => b.length - a.length)[0];
  const isActive = (path: string) => path === activePath;

  return (
    <nav className="bg-base-200/80 border-b border-white/[0.06] sticky top-0 z-50 backdrop-blur-xl">
      <div className="container mx-auto px-4 py-3 flex items-center justify-between">
        {/* Left: Logo */}
        <Link href="/" className="flex items-center gap-2.5 shrink-0">
          <Image
            src="/logo.jpg"
            alt="ArchAngel"
            width={32}
            height={32}
            className="rounded-lg"
          />
          <span className="font-display text-lg font-bold tracking-tight text-white">
            ArchAngel
          </span>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden md:flex items-center gap-1 bg-white/[0.03] border border-white/[0.06] rounded-full p-1">
          {navLinks.map((link) => {
            const active = isActive(link.path);
            return (
              <Link
                key={link.name}
                href={link.path}
                className={`relative px-3.5 py-1.5 text-sm font-medium rounded-full transition-colors ${
                  active
                    ? "text-white"
                    : "text-base-content/60 hover:text-base-content"
                }`}
                target={link.path.startsWith("http") ? "_blank" : "_self"}
              >
                {active && (
                  <motion.span
                    layoutId="nav-active-pill"
                    className="absolute inset-0 bg-primary rounded-full -z-10"
                    transition={{ type: "spring", duration: 0.5, bounce: 0.2 }}
                  />
                )}
                {link.name}
              </Link>
            );
          })}
        </div>

        {/* Wallet + Mobile Menu */}
        <div className="flex items-center gap-3">
          {mounted ? (
            <WalletMultiButton />
          ) : (
            <div className="h-10 w-32 bg-base-300 rounded-lg animate-pulse" />
          )}

          {/* Mobile Menu Toggle */}
          <button
            type="button"
            className="md:hidden text-base-content hover:text-primary transition p-1"
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="md:hidden overflow-hidden bg-base-200/95 border-t border-white/[0.06] backdrop-blur-xl"
          >
            <div className="flex flex-col px-4 py-3 gap-1">
              {navLinks.map((link) => {
                const active = isActive(link.path);
                return (
                  <Link
                    key={link.name}
                    href={link.path}
                    className={`text-sm font-medium px-3 py-2.5 rounded-lg transition ${
                      active
                        ? "bg-primary text-white"
                        : "text-base-content/80 hover:bg-white/5"
                    }`}
                    target={link.path.startsWith("http") ? "_blank" : "_self"}
                  >
                    {link.name}
                  </Link>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
};

export default Navbar;
