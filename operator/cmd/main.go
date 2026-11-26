// Command manager runs the EnvVault operator.
package main

import (
	"flag"
	"os"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	v1 "github.com/iserp-cloud/envvault/operator/api/v1alpha1"
	"github.com/iserp-cloud/envvault/operator/internal/controller"
	"github.com/iserp-cloud/envvault/operator/internal/vault"
)

// version is reported to the hub so the dashboard can show what each cluster runs.
const version = "0.2.0"

// defaultClusterToken is where the README tells you to put the cluster token.
const defaultClusterToken = "envvault-system/envvault-cluster-token"

// defaultLinkConfig is the optional ConfigMap that limits the namespaces links may use.
const defaultLinkConfig = "envvault-system/envvault-config"

func main() {
	var (
		metricsAddr string
		probeAddr   string
		leaderElect bool
		namespace   string
		qps         float64
		burst       int
		concurrency int

		clusterToken string
		hubURL       string
		hubPin       string
		hubCAFile    string
		hubPlain     bool
		linkConfig   string
		linkInterval time.Duration
	)
	flag.StringVar(&metricsAddr, "metrics-bind-address", "0", "Address for metrics; 0 disables them.")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8081", "Address for the health probes.")
	flag.BoolVar(&leaderElect, "leader-elect", false, "Elect a leader when running more than one replica.")
	flag.StringVar(&namespace, "namespace", "", "Only watch this namespace (default: all).")
	flag.Float64Var(&qps, "kube-api-qps", 50, "Requests per second the operator may send to the Kubernetes API. Raise it with many resources.")
	flag.IntVar(&burst, "kube-api-burst", 100, "Burst allowed above --kube-api-qps.")
	flag.IntVar(&concurrency, "concurrency", 8, "How many EnvVaultSecrets are reconciled at the same time.")
	flag.StringVar(&clusterToken, "cluster-token-secret", "", "namespace/name of the Secret holding this cluster's token (key \"token\"). Defaults to "+defaultClusterToken+". Links made in the dashboard start working once it exists.")
	flag.StringVar(&hubURL, "hub-url", "", "Hub address for links, if not the one in the cluster token (for example the in-cluster Service). The ConfigMap key hubUrl, read live, wins over it.")
	flag.StringVar(&hubPin, "hub-fingerprint", "", "Pin the hub's certificate (SHA-256) for links. The ConfigMap key hubFingerprint, read live, wins over it.")
	flag.StringVar(&hubCAFile, "hub-ca-file", "", "PEM file with the CA that signed the hub's certificate, for links.")
	flag.BoolVar(&hubPlain, "hub-allow-plain-http", false, "Allow an http:// hub for links. Only for a hub on the cluster network.")
	flag.StringVar(&linkConfig, "link-config", defaultLinkConfig, "namespace/name of an optional ConfigMap whose key \"namespaces\" (comma separated, or \"*\") limits where dashboard links may write. Read again on every poll, so changing it needs no restart; without it every namespace is allowed.")
	flag.DurationVar(&linkInterval, "link-interval", 30*time.Second, "How often the hub is asked for links.")
	zopts := zap.Options{}
	zopts.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&zopts)))
	setupLog := ctrl.Log.WithName("setup")

	scheme := runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(v1.AddToScheme(scheme))

	cacheOpts := cache.Options{
		// Only the Secrets and ConfigMaps this operator wrote, and push sources it labelled, are cached; token and CA Secrets and the settings ConfigMap are read on demand.
		ByObject: map[client.Object]cache.ByObject{
			&corev1.Secret{}:    {Label: controller.SecretSelector()},
			&corev1.ConfigMap{}: {Label: controller.ConfigMapSelector()},
		},
	}
	if namespace != "" {
		cacheOpts.DefaultNamespaces = map[string]cache.Config{namespace: {}}
	}

	restCfg := ctrl.GetConfigOrDie()
	restCfg.QPS, restCfg.Burst = float32(qps), burst

	mgr, err := ctrl.NewManager(restCfg, ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsserver.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         leaderElect,
		LeaderElectionID:       "envvault-operator.envvault.io",
		Cache:                  cacheOpts,
	})
	if err != nil {
		setupLog.Error(err, "unable to start manager")
		os.Exit(1)
	}
	rec := &controller.Reconciler{Client: mgr.GetClient(), APIReader: mgr.GetAPIReader(), Scheme: mgr.GetScheme(), Concurrency: concurrency, Recorder: mgr.GetEventRecorderFor("envvault-operator")}
	if err := rec.SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create controller")
		os.Exit(1)
	}
	if err := (&controller.PushReconciler{R: rec}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create push controller")
		os.Exit(1)
	}
	if clusterToken == "" {
		clusterToken = defaultClusterToken
	}
	ns, name, ok := strings.Cut(clusterToken, "/")
	if !ok || ns == "" || name == "" {
		setupLog.Error(nil, "--cluster-token-secret must be namespace/name")
		os.Exit(1)
	}
	opts := vault.TLSOptions{Fingerprint: hubPin}
	if hubCAFile != "" {
		pem, err := os.ReadFile(hubCAFile)
		if err != nil {
			setupLog.Error(err, "cannot read --hub-ca-file")
			os.Exit(1)
		}
		opts.CAPEM = pem
	}
	cfgNS, cfgName, ok := strings.Cut(linkConfig, "/")
	if !ok || cfgNS == "" || cfgName == "" {
		setupLog.Error(nil, "--link-config must be namespace/name")
		os.Exit(1)
	}
	links := &controller.LinkReconciler{
		R: rec, P: &controller.PushReconciler{R: rec},
		TokenSecret: types.NamespacedName{Namespace: ns, Name: name},
		HubURL:      hubURL, TLS: opts, AllowPlainHTTP: hubPlain, Interval: linkInterval, Version: version,
		Config: types.NamespacedName{Namespace: cfgNS, Name: cfgName},
	}
	if err := links.SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "unable to create link controller")
		os.Exit(1)
	}
	setupLog.Info("links from the dashboard are ready; they start once the cluster token Secret exists", "secret", clusterToken, "limit", linkConfig)
	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "unable to set up ready check")
		os.Exit(1)
	}
	setupLog.Info("starting manager")
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "manager exited")
		os.Exit(1)
	}
}
