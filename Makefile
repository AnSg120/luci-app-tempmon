include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-tempmon
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

LUCI_TITLE:=System Monitor Dashboard (temperature, CPU, memory, storage, network)
LUCI_DESCRIPTION:=luci-app-tempmon v1.0.0 首发正式版，界面重构，PC与移动端自适应，修复A/B/C/D/E原有体验痛点，稳定采集硬件温度，支持历史曲线查看。
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all
PKG_MAINTAINER:=luci-app-tempmon contributors
PKG_LICENSE:=GPL-2.0-only

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature