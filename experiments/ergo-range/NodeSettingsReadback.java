// Offline inspection only: invoke the pinned settings loader, never ErgoApp.main.
import com.typesafe.config.Config;
import com.typesafe.config.ConfigRenderOptions;
import com.typesafe.config.ConfigValueFactory;
import java.lang.reflect.Method;
import java.util.LinkedHashMap;
import java.util.Map;
import org.ergoplatform.settings.*;
import scala.Option;
import scala.Some;

public final class NodeSettingsReadback {
    public static void main(String[] argv) throws Exception {
        if (argv.length != 1) throw new IllegalArgumentException("One config path required");
        NetworkType mainnet = (NetworkType) Class.forName(
            "org.ergoplatform.settings.NetworkType$MainNet$").getField("MODULE$").get(null);
        Option<NetworkType> network = new Some<NetworkType>(mainnet);
        Args args = new Args(new Some<String>(argv[0]), network);
        ErgoSettingsReader$ reader = ErgoSettingsReader$.MODULE$;
        // readConfig is private in the pinned artifact. Reflect its exact method;
        // duplicating HOCON precedence here would measure a different loader.
        Method readConfig = reader.getClass().getDeclaredMethod("readConfig", Args.class);
        readConfig.setAccessible(true);
        Config config = (Config) readConfig.invoke(reader, args);
        ErgoSettings settings = reader.fromConfig(config, network);
        Map<String, Object> result = new LinkedHashMap<String, Object>();
        Map<String, Object> resolved = new LinkedHashMap<String, Object>();
        String[] paths = {
            "ergo.directory", "ergo.networkType", "ergo.node.stateType",
            "ergo.node.verifyTransactions", "ergo.node.blocksToKeep", "ergo.node.checkpoint",
            "ergo.node.utxo.utxoBootstrap", "ergo.node.utxo.storingUtxoSnapshots",
            "ergo.node.nipopow.nipopowBootstrap", "ergo.node.mining",
            "ergo.node.offlineGeneration", "ergo.node.extraIndex",
            "ergo.wallet.secretStorage.secretDir", "ergo.wallet.testKeysQty",
            "scorex.dataDir", "scorex.logDir", "scorex.logging.level",
            "scorex.restApi.bindAddress", "scorex.restApi.apiKeyHash", "scorex.restApi.publicUrl",
            "scorex.restApi.corsAllowedOrigin", "scorex.network.bindAddress",
            "scorex.network.knownPeers", "scorex.network.bannedPeers",
            "scorex.network.peerDiscovery", "scorex.network.maxConnections",
            "scorex.network.upnpEnabled", "scorex.network.declaredAddress",
            "scorex.network.magicBytes", "ergo.chain.addressPrefix", "ergo.chain.genesisId"
        };
        for (String path : paths) resolved.put(path, config.getIsNull(path) ? null : config.getAnyRef(path));
        // Never serialize a mnemonic, including an unexpected override.
        resolved.put("ergo.wallet.testMnemonicAbsent", config.getIsNull("ergo.wallet.testMnemonic"));
        result.put("resolved", resolved);
        NodeConfigurationSettings node = settings.nodeSettings();
        Map<String, Object> typed = new LinkedHashMap<String, Object>();
        typed.put("mainnet", settings.networkType().equals(mainnet));
        typed.put("stateType", node.stateType().toString());
        typed.put("verifyTransactions", node.verifyTransactions());
        typed.put("blocksToKeep", node.blocksToKeep());
        typed.put("checkpointAbsent", node.checkpoint().isEmpty());
        typed.put("utxoBootstrap", node.utxoSettings().utxoBootstrap());
        typed.put("storingUtxoSnapshots", node.utxoSettings().storingUtxoSnapshots());
        typed.put("nipopowBootstrap", node.nipopowSettings().nipopowBootstrap());
        typed.put("isFullBlocksPruned", node.isFullBlocksPruned());
        typed.put("areSnapshotsStored", node.areSnapshotsStored());
        typed.put("mining", node.mining());
        typed.put("offlineGeneration", node.offlineGeneration());
        typed.put("extraIndex", node.extraIndex());
        typed.put("testMnemonicAbsent", settings.walletSettings().testMnemonic().isEmpty());
        typed.put("testKeysQtyAbsent", settings.walletSettings().testKeysQty().isEmpty());
        result.put("typed", typed);
        NetworkSettings networkSettings = settings.scorexSettings().network();
        Map<String, Object> peers = new LinkedHashMap<String, Object>();
        peers.put("maxConnections", networkSettings.maxConnections());
        peers.put("peerDiscovery", networkSettings.peerDiscovery());
        peers.put("allowLocal", networkSettings.allowLocal());
        peers.put("upnpEnabled", networkSettings.upnpEnabled());
        peers.put("declaredAddressAbsent", networkSettings.declaredAddress().isEmpty());
        peers.put("bindAddress", networkSettings.bindAddress().getAddress().getHostAddress());
        peers.put("bindPort", networkSettings.bindAddress().getPort());
        java.util.List<String> seeds = new java.util.ArrayList<String>();
        for (java.net.InetSocketAddress seed : scala.collection.JavaConverters
                .seqAsJavaListConverter(networkSettings.knownPeers()).asJava()) {
            seeds.add(seed.getAddress().getHostAddress() + ":" + seed.getPort());
        }
        peers.put("knownPeers", seeds);
        peers.put("connectionTimeoutMs", networkSettings.connectionTimeout().toMillis());
        peers.put("handshakeTimeoutMs", networkSettings.handshakeTimeout().toMillis());
        peers.put("deliveryTimeoutMs", networkSettings.deliveryTimeout().toMillis());
        peers.put("inactiveConnectionDeadlineMs", networkSettings.inactiveConnectionDeadline().toMillis());
        peers.put("maxDeliveryChecks", networkSettings.maxDeliveryChecks());
        peers.put("maxPeerSpecObjects", networkSettings.maxPeerSpecObjects());
        peers.put("desiredInvObjects", networkSettings.desiredInvObjects());
        result.put("network", peers);
        Map<String, Object> properties = new LinkedHashMap<String, Object>();
        for (String name : new String[] {"java.version", "java.io.tmpdir", "user.home", "user.dir",
                "logback.configurationFile", "java.library.path"}) properties.put(name, System.getProperty(name));
        result.put("properties", properties);
        System.out.println("MOE_SETTINGS_JSON=" + ConfigValueFactory.fromMap(result).render(
            ConfigRenderOptions.concise().setJson(true)));
    }
}
